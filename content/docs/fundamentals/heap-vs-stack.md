---
title: "Heap vs Stack Memory"
description: "Mổ xẻ bộ nhớ JVM: stack frame & local variable array, heap & object layout (header/oop), tham chiếu vs giá trị, escape analysis + scalar replacement + TLAB, StackOverflowError vs OutOfMemoryError, và vì sao 'Java truyền tham chiếu' là hiểu sai. Kèm sơ đồ và đọc bytecode."
---

## Mục lục

- [StackOverflowError lúc 2 giờ sáng](#1-stackoverflowerror-lúc-2-giờ-sáng)
- [Bản đồ bộ nhớ runtime của JVM](#2-bản-đồ-bộ-nhớ-runtime-của-jvm)
- [Stack — frame, local array và operand stack](#3-stack--frame-local-array-và-operand-stack)
- [Heap — object layout, header và reference](#4-heap--object-layout-header-và-reference)
- [Giá trị nằm ở đâu — primitive vs object vs reference](#5-giá-trị-nằm-ở-đâu--primitive-vs-object-vs-reference)
- ["Java truyền tham chiếu" — hiểu lầm kinh điển](#6-java-truyền-tham-chiếu--hiểu-lầm-kinh-điển)
- [Escape Analysis — khi object không cần lên heap](#7-escape-analysis--khi-object-không-cần-lên-heap)
- [TLAB — vì sao cấp phát heap gần như miễn phí](#8-tlab--vì-sao-cấp-phát-heap-gần-như-miễn-phí)
- [StackOverflowError vs OutOfMemoryError](#9-stackoverflowerror-vs-outofmemoryerror)
- [Tinh chỉnh: -Xss, -Xmx và đo đạc](#10-tinh-chỉnh--xss--xmx-và-đo-đạc)
- [Anti-patterns cần tránh](#11-anti-patterns-cần-tránh)
- [Tóm tắt — Cheat sheet & nguyên tắc](#12-tóm-tắt--cheat-sheet--nguyên-tắc)

---

## 1. StackOverflowError lúc 2 giờ sáng

JVM chia bộ nhớ runtime thành các vùng khác nhau: **stack** (per-thread, lưu stack frame của từng method call, tự pop khi return) và **heap** (chia sẻ toàn JVM, chứa mọi object và mảng, do GC dọn). Hiểu heap vs stack là hiểu *cái gì sống ở đâu, sống bao lâu, và ai dọn nó* — nền tảng để đọc mọi lỗi bộ nhớ của JVM, từ `StackOverflowError` đến `OutOfMemoryError`.

Một service xử lý cây danh mục lồng nhau crash với `StackOverflowError`. Hàm đệ quy duyệt cây trông hoàn toàn bình thường:

```java
long countNodes(Category c) {
    long total = 1;
    for (Category child : c.children())
        total += countNodes(child);     // đệ quy
    return total;
}
```

Lỗi không phải vì cây quá lớn — mà vì một danh mục bị nhập sai khiến nó **chứa chính nó** làm con → đệ quy **vô hạn**. Mỗi lời gọi `countNodes` đẩy một **stack frame** mới; sau ~10.000–20.000 frame, stack của thread cạn kiệt:

```
Exception in thread "main" java.lang.StackOverflowError
    at Catalog.countNodes(Catalog.java:3)
    at Catalog.countNodes(Catalog.java:5)
    at Catalog.countNodes(Catalog.java:5)
    ... (lặp lại hàng vạn lần)
```

> [!IMPORTANT]
> `StackOverflowError` và `OutOfMemoryError` là **hai vùng nhớ khác nhau** cạn kiệt theo **hai cơ chế khác nhau**. Hiểu heap vs stack là hiểu *cái gì sống ở đâu, sống bao lâu, và ai dọn nó* — nền tảng để đọc mọi lỗi bộ nhớ của JVM.

Phần còn lại của doc sẽ đi qua: bản đồ bộ nhớ runtime JVM (§2) → stack frame & local array (§3) → heap object layout & reference (§4) → giá trị nằm ở đâu (§5) → hiểu lầm "Java truyền tham chiếu" (§6) → escape analysis (§7) → TLAB (§8) → StackOverflowError vs OutOfMemoryError (§9) → tinh chỉnh -Xss/-Xmx (§10) → anti-patterns (§11) → cheat sheet (§12).

---

## 2. Bản đồ bộ nhớ runtime của JVM

JVM chia bộ nhớ runtime thành các vùng, mỗi vùng có vòng đời và phạm vi chia sẻ khác nhau:

```
┌───────────────────────────── JVM Process Memory ─────────────────────────────┐
│                                                                              │
│   HEAP  (chia sẻ toàn JVM, GC quản lý)        METASPACE (native, chia sẻ)    │
│   ┌──────────────┬──────────────┐             ┌──────────────────────────┐   │
│   │  Young Gen   │   Old Gen    │             │ class metadata, method,  │   │
│   │ Eden+S0+S1   │ object sống  │             │ static field, constant   │   │
│   └──────────────┴──────────────┘             └──────────────────────────┘   │
│                                                                              │
│   PER-THREAD (mỗi thread một bộ riêng)                                       │
│   ┌──────────────┬──────────────┬──────────────┐                             │
│   │  JVM Stack   │  PC Register │ Native Stack │  × N thread                 │
│   └──────────────┴──────────────┴──────────────┘                             │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Vùng | Chia sẻ? | Chứa gì | Ai dọn |
|------|----------|---------|--------|
| **Heap** | Toàn JVM | **Mọi object** + mảng | Garbage Collector |
| **Stack** | Mỗi thread riêng | Frame: local var, operand stack | Tự pop khi method return |
| **Metaspace** | Toàn JVM | Class metadata, static field | GC (khi class unload) |
| **PC Register** | Mỗi thread | Địa chỉ lệnh đang chạy | — |

Trọng tâm doc này là hai vùng bạn chạm hằng ngày: **Stack** (vòng đời method) và **Heap** (vòng đời object).

---

## 3. Stack — frame, local array và operand stack

Mỗi thread có **một JVM stack**. Mỗi lần **gọi method** đẩy một **stack frame**; method **return** thì pop frame đó. Frame chứa:

```
┌─────────── Stack Frame (một method call) ──────────────────┐
│ Local Variable Array  │ slot 0: this                       │
│                       │ slot 1: tham số / biến cục bộ      │
│                       │ slot 2: ...                        │
│───────────────────────┼────────────────────────────────────│
│ Operand Stack         │ vùng tính toán tạm (push/pop)      │
│───────────────────────┼────────────────────────────────────│
│ Frame Data            │ ref tới constant pool, return addr │
└────────────────────────────────────────────────────────────┘
```

- **Local Variable Array**: lưu tham số và biến cục bộ. `long`/`double` chiếm **2 slot**, còn lại 1 slot. `this` luôn ở slot 0 (method instance).
- **Operand Stack**: nơi bytecode thực thi — `iadd` pop 2 int, cộng, push lại. JVM là **stack machine**.

Đọc bytecode cho `int sum(int a, int b) { return a + b; }`:

```text
0: iload_1     // push a (slot 1) lên operand stack
1: iload_2     // push b (slot 2)
2: iadd        // pop 2, cộng, push kết quả
3: ireturn     // pop, trả về
```

Đặc tính then chốt của stack:

- **Cấp phát/giải phóng = di chuyển con trỏ stack** → cực nhanh, không cần GC.
- **LIFO nghiêm ngặt** → biến cục bộ tự biến mất khi method return.
- **Thread-confined** → biến cục bộ **vốn dĩ thread-safe** (mỗi thread stack riêng), không cần đồng bộ.
- **Kích thước hữu hạn** (mặc định ~512KB–1MB/thread) → đệ quy quá sâu = `StackOverflowError`.

> [!NOTE]
> Vì biến cục bộ nằm trên stack riêng của mỗi thread, **chúng không bao giờ bị tranh chấp đa luồng** — đây là nền tảng của "stack confinement", một kỹ thuật thread-safety. Chỉ object **chia sẻ trên heap** mới cần `synchronized`/`volatile`.

---

## 4. Heap — object layout, header và reference

**Mọi object** (`new`) và **mọi mảng** sống trên **heap**, chia sẻ giữa các thread, do GC quản lý. Một object trong HotSpot có layout:

```
┌──────────── Object trên Heap ─────────────┐
│ Object Header                             │
│   ├─ Mark Word (8 byte): hash, GC age,    │
│   │   lock state (biased/thin/fat)        │
│   └─ Klass Pointer (4 byte nén): trỏ class│
│───────────────────────────────────────────│
│ Instance Fields (int, ref, ...)           │
│───────────────────────────────────────────│
│ Padding → bội số 8 byte (alignment)       │
└───────────────────────────────────────────┘
```

- **Mark Word** lưu identity hashCode (mục equals-hashCode), tuổi GC, và **trạng thái khóa** — chính nơi `synchronized` ghi (xem [synchronized internals](/concurrency/synchronized-internals-deep-dive/)).
- **Klass Pointer** trỏ tới metadata class trong Metaspace. Với **Compressed Oops** (`-XX:+UseCompressedOops`, mặc định khi heap < 32GB), reference chỉ 4 byte thay vì 8.
- Object header tốn ~12–16 byte — lý do tạo hàng triệu object nhỏ (như wrapper) tốn kém.

> [!TIP]
> Đo layout thật bằng JOL (Java Object Layout): `ClassLayout.parseClass(MyClass.class).toPrintable()`. Bạn sẽ thấy chính xác header, field offset, và padding — rất hữu ích khi tối ưu cache line.

---

## 5. Giá trị nằm ở đâu — primitive vs object vs reference

Đây là phần hay nhầm nhất. Cùng một biến cục bộ trên stack, nhưng nội dung khác nhau:

```java
void demo() {
    int x = 42;                       // [stack] slot chứa thẳng 42
    int[] arr = new int[]{1, 2, 3};   // [stack] slot chứa REFERENCE → [heap] mảng
    String s = "hi";                  // [stack] slot chứa REFERENCE → [heap] object
}
```

```
        STACK (frame demo)              HEAP
        ┌──────────────┐
 x      │      42      │  ← giá trị nằm thẳng trên stack
        ├──────────────┤                ┌──────────────┐
 arr    │   ref ───────┼──────────────▶ │ [1, 2, 3]    │
        ├──────────────┤                ├──────────────┤
 s      │   ref ───────┼──────────────▶ │ "hi"         │
        └──────────────┘                └──────────────┘
```

| Loại | Slot trên stack chứa | Object thực |
|------|----------------------|-------------|
| Primitive cục bộ (`int x`) | **chính giá trị** | (không có) |
| Reference (`String s`) | **reference** (con trỏ) | trên heap |
| Field của object | nằm **trong object trên heap** | trên heap |

> [!IMPORTANT]
> Primitive **cục bộ** nằm trên stack. Nhưng primitive là **field của object** (vd `point.x`) nằm trên **heap**, bên trong object đó. "Primitive luôn ở stack" là **sai** — vị trí phụ thuộc primitive đó là biến cục bộ hay field.

---

## 6. "Java truyền tham chiếu" — hiểu lầm kinh điển

Java **luôn truyền theo giá trị (pass-by-value)**. Với object, **giá trị được copy chính là reference** — không phải object. Hệ quả:

```java
void mutate(StringBuilder sb) { sb.append(" world"); }   // sửa object được TRỎ TỚI → thấy
void reassign(StringBuilder sb) { sb = new StringBuilder("new"); } // gán lại COPY reference → KHÔNG thấy

StringBuilder a = new StringBuilder("hello");
mutate(a);    System.out.println(a);  // "hello world"  ← sửa cùng object
reassign(a);  System.out.println(a);  // "hello world"  ← reassign chỉ đổi copy cục bộ
```

```
Trước gọi:   a (stack) ─ref─▶ [object "hello"] (heap)

mutate(sb):  sb là COPY của ref a, cùng trỏ object
             sb.append → SỬA object trên heap → a cũng thấy ✓

reassign(sb): sb = new... → COPY sb trỏ object MỚI
              a vẫn trỏ object cũ → KHÔNG đổi ✗
```

> [!WARNING]
> Phát biểu đúng: *Java truyền **bản sao của reference**.* Bạn có thể **sửa nội dung** object qua bản sao reference đó (cùng địa chỉ heap), nhưng **gán lại** tham số chỉ đổi bản sao cục bộ — biến gốc ngoài method không hề thay đổi. Đây là lý do swap hai object bằng method không bao giờ hoạt động.

---

## 7. Escape Analysis — khi object không cần lên heap

"Mọi object lên heap" là quy tắc của **ngôn ngữ**, không phải của **JIT đã tối ưu**. C2/JIT chạy **Escape Analysis**: phân tích xem object có "thoát" khỏi method/thread không. Nếu **không thoát**, JIT có thể:

- **Scalar Replacement**: "xé" object thành các field nguyên thủy rời và đặt thẳng trên **stack/thanh ghi** — object **không bao giờ được cấp phát** trên heap.
- **Lock Elision**: bỏ luôn `synchronized` trên object không thoát (không thread nào khác thấy được).

```java
int hypotSquared(int a, int b) {
    Point p = new Point(a, b);   // tưởng cấp phát heap...
    return p.x * p.x + p.y * p.y; // p không thoát → JIT xé thành 2 int trên stack, KHÔNG new
}
```

Ba mức "thoát":

| Mức | Nghĩa | JIT làm gì |
|-----|-------|------------|
| **NoEscape** | Object chỉ dùng trong method | Scalar replacement (không heap alloc) |
| **ArgEscape** | Truyền vào method khác nhưng không lưu | Có thể lock elision |
| **GlobalEscape** | Lưu vào field/static/trả về/vào collection | Buộc cấp phát heap |

> [!CAUTION]
> Escape analysis là tối ưu **cơ hội** — dễ vỡ. Thêm một dòng làm object "thoát" (gán vào field, đưa vào `List`, trả về) → object lại lên heap. Đừng *dựa* vào nó để viết code cẩu thả; nhưng hiểu nó giải thích vì sao "tạo object nhỏ trong vòng lặp" đôi khi **không** tốn gì như bạn lo.

Bật/tắt để quan sát: `-XX:+DoEscapeAnalysis` (mặc định bật), `-XX:-DoEscapeAnalysis` để tắt và đo chênh lệch.

---

## 8. TLAB — vì sao cấp phát heap gần như miễn phí

Người ta hay nói "cấp phát heap chậm". Với HotSpot hiện đại, cấp phát object **sống ngắn** gần như **miễn phí** nhờ **TLAB (Thread-Local Allocation Buffer)**:

- Eden (vùng young) được chia thành các **buffer riêng cho từng thread**.
- Cấp phát = **tăng một con trỏ** (bump-the-pointer) trong TLAB của thread → không cần khóa, không tranh chấp.
- Chỉ khi TLAB đầy mới xin buffer mới (hiếm, có khóa).

```
Eden:  [─── TLAB thread A ───][─── TLAB thread B ───][ free ... ]
                    ▲ ptr                    ▲ ptr
  new Object() = ptr += size  (một lệnh tăng con trỏ, không khóa)
```

Kết hợp với **generational GC**: object trẻ chết sớm được dọn cực rẻ trong minor GC (copy số ít object còn sống sang survivor). Đây là lý do phong cách "tạo nhiều object nhỏ sống ngắn" trong Java thường **chấp nhận được** về hiệu năng — khác hẳn trực giác từ C/C++.

> [!NOTE]
> Cặp đôi **TLAB + Escape Analysis** giải thích vì sao Java không phạt nặng việc tạo object như nhiều người nghĩ: hoặc object bị xé bỏ hoàn toàn (escape analysis), hoặc cấp phát bằng một phép tăng con trỏ rồi dọn rẻ (TLAB + minor GC).

---

## 9. StackOverflowError vs OutOfMemoryError

Hai lỗi, hai vùng, hai nguyên nhân — đừng nhầm:

| | `StackOverflowError` | `OutOfMemoryError: Java heap space` |
|---|----------------------|--------------------------------------|
| Vùng | **Stack** (per-thread) | **Heap** (chia sẻ) |
| Nguyên nhân | Đệ quy quá sâu / vô hạn, frame quá lớn | Quá nhiều object sống, leak, `-Xmx` nhỏ |
| Sửa | Bỏ đệ quy / thêm điều kiện dừng / `-Xss` lớn hơn | Sửa leak, tăng `-Xmx`, giảm giữ tham chiếu |
| Là `Error` | Có (không nên catch để "tiếp tục") | Có |

Các biến thể OOM khác:

```text
OutOfMemoryError: Java heap space          → heap đầy (leak, -Xmx nhỏ)
OutOfMemoryError: Metaspace                → quá nhiều class (classloader leak)
OutOfMemoryError: unable to create native thread → quá nhiều thread (mỗi thread tốn stack native)
OutOfMemoryError: GC overhead limit exceeded → GC chạy >98% thời gian, dọn <2%
```

> [!IMPORTANT]
> Đệ quy sâu hợp lệ (vd duyệt cây cân bằng triệu node) hiếm khi tràn stack vì độ sâu chỉ ~log(n). Tràn stack gần như luôn là dấu hiệu **đệ quy vô hạn** (thiếu điều kiện dừng, cấu trúc có chu trình) — hãy nghi ngờ logic trước khi tăng `-Xss`.

---

## 10. Tinh chỉnh: -Xss, -Xmx và đo đạc

| Flag | Ý nghĩa | Ghi chú |
|------|---------|---------|
| `-Xss512k` | Kích thước stack mỗi thread | Tăng cho đệ quy sâu; nhưng nhiều thread × stack lớn = tốn native mem |
| `-Xms2g -Xmx2g` | Heap khởi tạo / tối đa | Đặt bằng nhau để tránh resize heap lúc runtime |
| `-XX:+HeapDumpOnOutOfMemoryError` | Dump heap khi OOM | Phân tích bằng Eclipse MAT để tìm leak |
| `-Xmn` / `-XX:NewRatio` | Kích thước young gen | Young lớn → minor GC ít hơn |
| `-XX:+UseCompressedOops` | Nén reference 8→4 byte | Mặc định bật khi heap < 32GB |

Quan sát thực tế:

```bash
# In thông số bộ nhớ JVM đang dùng
java -XX:+PrintFlagsFinal -version | grep -E "ThreadStackSize|MaxHeapSize"

# Theo dõi heap/GC realtime
jstat -gc <pid> 1000

# Dump & phân tích khi nghi leak
jmap -dump:live,format=b,file=heap.hprof <pid>
```

> [!TIP]
> `StackOverflowError` quá nhanh thường do `-Xss` nhỏ + frame lớn (nhiều biến cục bộ / `long`/`double` chiếm 2 slot). Nếu buộc đệ quy sâu, cân nhắc **chuyển sang vòng lặp + `Deque` tường minh** thay vì tăng `-Xss` — biến đệ quy thành duyệt với stack trên **heap** (lớn hơn nhiều).

---

## 11. Anti-patterns cần tránh

| Anti-pattern | Vì sao sai | Thay bằng |
|--------------|-----------|-----------|
| Đệ quy không có/sai điều kiện dừng | `StackOverflowError` | Kiểm tra dừng; hoặc vòng lặp + Deque |
| Tưởng swap object qua method được | Java pass-by-value reference → không đổi biến gốc | Trả về giá trị mới / dùng wrapper holder |
| Giữ tham chiếu object không cần | Object không được GC → OOM/leak | Bỏ tham chiếu, dùng cache có giới hạn |
| Tăng `-Xss` để "chữa" đệ quy vô hạn | Chỉ trì hoãn crash, ẩn bug | Sửa logic đệ quy |
| Tạo nhiều thread, mỗi thread `-Xss` lớn | OOM native (unable to create thread) | Thread pool, virtual threads |
| Coi mọi `new` là "tốn heap" | Bỏ qua escape analysis + TLAB | Ưu tiên rõ ràng; tối ưu khi đo được |

---

## 12. Tóm tắt — Cheat sheet & nguyên tắc

**Cỗ máy trong 6 dòng:**

```
1. STACK: per-thread, LIFO frame, cấp phát = dời con trỏ, tự dọn khi return
2. HEAP : chia sẻ, chứa MỌI object + mảng, GC dọn
3. biến cục bộ primitive → trên stack; object & field → trên heap
4. Java luôn pass-by-value; với object là COPY của reference
5. Escape Analysis → object không thoát có thể KHÔNG lên heap (scalar replacement)
6. TLAB → cấp phát young gen ≈ bump con trỏ, gần như miễn phí
```

| | Stack | Heap |
|---|-------|------|
| Phạm vi | Mỗi thread | Toàn JVM |
| Chứa | frame, local var, reference | object, mảng, field |
| Dọn | tự pop khi return | Garbage Collector |
| Lỗi cạn | `StackOverflowError` | `OutOfMemoryError` |
| Thread-safe | có (confined) | không (cần đồng bộ) |

**5 nguyên tắc khắc cốt:**

1. **Object luôn ở heap, biến cục bộ primitive ở stack** — reference chỉ là con trỏ trên stack.
2. **Java pass-by-value** — sửa nội dung object thì thấy, gán lại tham số thì không.
3. **StackOverflow ≠ OutOfMemory** — sai vùng, sai nguyên nhân, sai cách chữa.
4. **Tràn stack = nghi đệ quy vô hạn trước**, không phải `-Xss` nhỏ.
5. **Đừng sợ object nhỏ sống ngắn** — escape analysis + TLAB + minor GC làm chúng rẻ.

> [!TIP]
> Một câu để nhớ: *Stack lưu "method đang làm gì", heap lưu "dữ liệu tồn tại bao lâu".* Mọi lỗi bộ nhớ JVM, lần ngược lại, đều quy về câu hỏi: cái này sống ở vùng nào, sống bao lâu, và ai chịu trách nhiệm dọn nó.
