---
title: "Heap vs Stack Memory"
description: "Mổ xẻ bộ nhớ JVM: stack frame & local variable array, heap & object layout (header/oop), tham chiếu vs giá trị, escape analysis + scalar replacement + TLAB, StackOverflowError vs OutOfMemoryError, và vì sao 'Java truyền tham chiếu' là hiểu sai. Kèm sơ đồ và đọc bytecode."
---

Heap và stack phục vụ các vai trò khác nhau trong bộ nhớ runtime của JVM. Stack tổ chức trạng thái của từng lời gọi method theo thread, còn heap chứa object được chia sẻ và quản lý bởi garbage collector.

## Mục lục

- [Tổng quan](#1-tổng-quan)
- [Bản đồ bộ nhớ runtime của JVM](#2-bản-đồ-bộ-nhớ-runtime-của-jvm)
- [Stack — frame, local array và operand stack](#3-stack--frame-local-array-và-operand-stack)
- [Heap — object layout, header và reference](#4-heap--object-layout-header-và-reference)
- [Giá trị nằm ở đâu — primitive vs object vs reference](#5-giá-trị-nằm-ở-đâu--primitive-vs-object-vs-reference)
- ["Java truyền tham chiếu" — hiểu lầm kinh điển](#6-java-truyền-tham-chiếu--hiểu-lầm-kinh-điển)
  - [Ví von: photocopy địa chỉ nhà](#ví-von-photocopy-địa-chỉ-nhà)
  - [Chạy thật: in địa chỉ object](#chạy-thật-in-địa-chỉ-object)
  - [Từng bước trong bộ nhớ](#từng-bước-trong-bộ-nhớ)
  - [Bài test phát hiện pass-by-reference thật](#bài-test-phát-hiện-pass-by-reference-thật)
- [Escape Analysis — khi object không cần lên heap](#7-escape-analysis--khi-object-không-cần-lên-heap)
- [TLAB — vì sao cấp phát heap gần như miễn phí](#8-tlab--vì-sao-cấp-phát-heap-gần-như-miễn-phí)
- [StackOverflowError vs OutOfMemoryError](#9-stackoverflowerror-vs-outofmemoryerror)
- [Tinh chỉnh: -Xss, -Xmx và đo đạc](#10-tinh-chỉnh--xss--xmx-và-đo-đạc)
- [Anti-patterns cần tránh](#11-anti-patterns-cần-tránh)
- [Tóm tắt — Cheat sheet & nguyên tắc](#12-tóm-tắt--cheat-sheet--nguyên-tắc)

---

## 1. Tổng quan

Mỗi thread có stack riêng gồm các frame; mỗi frame giữ local variable, operand stack và thông tin trả về. Object thường nằm trên heap, trong khi biến reference có thể nằm trong frame hoặc trong object khác.

Cách phân chia này giúp giải thích `StackOverflowError`, `OutOfMemoryError`, vòng đời biến cục bộ và chi phí cấp phát. Tuy nhiên JVM có thể tối ưu vị trí vật lý của object, nên không nên đồng nhất mô hình ngôn ngữ với một bố trí bộ nhớ tuyệt đối.

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

Nhiều người tin "Java truyền tham chiếu" vì họ từng viết method sửa nội dung object, và người gọi *thấy* thay đổi — nhìn cứ như tham chiếu được truyền vào. Phát biểu đó **sai**. Chỉ cần nắm được một câu là giải thích được mọi hành vi:

> Biến `a` **không chứa object** — nó chỉ chứa **địa chỉ** trỏ tới object trên heap. Gọi method, Java **copy đúng cái địa chỉ đó** vào tham số: copy **địa chỉ**, không copy object — và tham số cũng không "trở thành" biến gốc.

Nói chuẩn thuật ngữ: Java **luôn truyền theo giá trị (pass-by-value)**. Với primitive, giá trị được copy là con số. Với object, giá trị được copy **chính là reference** (cái địa chỉ). Điểm mấu chốt: **bản sao địa chỉ vẫn trỏ về đúng object gốc**.

### Ví von: photocopy địa chỉ nhà

Tưởng tượng `a` là tờ giấy ghi địa chỉ **số nhà 123**; object thật trên heap là căn nhà tại số 123. Gọi `mutate(a)` tức là **photocopy** tờ giấy rồi đưa bản photo cho method:

- `sb.append(" world")` = cầm bản photo, đi tới **ngôi nhà**, sơn lại tường. Tờ gốc và bản photo cùng chỉ một căn nhà → nhà bị sửa thật → `a` **thấy**.
- `sb = new StringBuilder("new")` = **tẩy số 123 trên bản photo**, ghi lên đó số 999. Tờ giấy gốc `a` của người gọi không ai đụng tới → `a` **không thấy**.
- `swap(x, y)` = hoán đổi nội dung **hai tờ photo** cho nhau. Tờ gốc ngoài kia y nguyên → **không thấy**.

| Method làm gì | Điều gì xảy ra | Người gọi thấy? |
|---|---|---|
| `sb.append(...)` — sửa **object được trỏ tới** | Bản sao và reference gốc cùng trỏ **một object** → object bị sửa thật | ✅ Thấy |
| `sb = new ...` — **gán lại tham số** | Chỉ đổi bản sao cục bộ; reference gốc không ai đụng tới | ❌ Không thấy |
| `swap(x, y)` — hoán đổi **hai tham số** | Hoán đổi hai bản sao; biến gốc y nguyên | ❌ Không thấy |

### Chạy thật: in địa chỉ object

In "địa chỉ" của object ra màn hình bằng `System.identityHashCode` — mã định danh duy nhất cho mỗi object. JVM giấu địa chỉ heap thật, nhưng mã này đủ để biết hai reference có đang trỏ cùng một object hay không:

```java
class PassByValueDemo {
    static String addr(Object o) {  // mã định danh ~ "địa chỉ" của object
        return "@" + Integer.toHexString(System.identityHashCode(o));
    }

    static void mutate(StringBuilder sb) {               // (1) sửa object được trỏ tới
        System.out.println("  mutate nhận ref:  " + addr(sb));
        sb.append(" world");
    }

    static void reassign(StringBuilder sb) {             // (2) gán lại tham số
        sb = new StringBuilder("new");
        System.out.println("  reassign sau gán: " + addr(sb));
    }

    static void swap(StringBuilder x, StringBuilder y) { // (3) hoán đổi 2 tham số
        StringBuilder t = x; x = y; y = t;
    }

    public static void main(String[] args) {
        StringBuilder a = new StringBuilder("hello");
        System.out.println("a ban đầu:          " + addr(a));

        mutate(a);
        System.out.println("sau mutate:         " + a);

        reassign(a);
        System.out.println("sau reassign:       " + a);

        StringBuilder b = new StringBuilder("B");
        swap(a, b);
        System.out.println("sau swap:           " + a + " | " + b);
    }
}
```

Output:

```text
a ban đầu:          @6646153
  mutate nhận ref:  @6646153      ← CÙNG địa chỉ với a: sb là bản sao của ref a
sau mutate:         hello world
  reassign sau gán: @21507a04     ← sb trỏ object mới, nhưng a không hề biết
sau reassign:       hello world   ← a vẫn giữ địa chỉ cũ, giá trị y nguyên
sau swap:           hello world | B
```

Ba dòng đáng chép nhớ: `mutate` nhận **đúng địa chỉ** mà `a` đang giữ (bằng chứng "copy địa chỉ, không copy object"); `reassign` làm `sb` trỏ sang **địa chỉ mới** trong khi `a` vẫn giữ địa chỉ cũ; `swap` không đổi được gì.

### Từng bước trong bộ nhớ

```text
BƯỚC 0 — trước khi gọi:
   stack main                       heap
   a ──[ref @6646153]──────▶  [ StringBuilder "hello" ]

BƯỚC 1 — gọi mutate(a): copy CON SỐ @6646153 vào slot sb
   stack main:            a ──[@6646153]──┐
   stack mutate:          sb ──[@6646153]─┤
                                          ▼
                              [ StringBuilder "hello" ]  ← CHỈ MỘT object
   sb.append(" world") sửa object này → a cũng thấy ✓

BƯỚC 2 — gọi reassign(a): copy như trên, nhưng method chạy sb = new ...
   stack main:            a ──[@6646153]─────────▶ [ "hello world" ]  ← vô sự
   stack mutate:          sb ──[@21507a04]──▶ [ "new" ]  ← object mới
   method return → slot sb bị vứt bỏ → object "new" thành rác chờ GC
```

### Bài test phát hiện pass-by-reference thật

Muốn biết một ngôn ngữ có "pass-by-reference" thật không, chỉ cần một câu hỏi: *method có thay đổi được **chính biến** của người gọi không?* Thử gán lại tham số:

```java
static void changeIt(StringBuilder param) {
    param = new StringBuilder("CHANGED");  // nếu là pass-by-reference thật,
}                                           // biến gốc sẽ trỏ sang object mới
```

- **Java**: biến gốc không đổi → pass-by-value ✅
- **C++** với `void f(String& s)`: `s` là *alias* trỏ thẳng vào ô nhớ của biến gốc → gán `s` chính là gán biến gốc → swap hoạt động. Đó mới là pass-by-reference thật.

Vì sao hiểu lầm này sống dai dẳng đến vậy? Vì `mutate(a)` **thay đổi được thứ mà `a` trỏ tới** — nhìn cứ như tham chiếu được truyền vào. Nhưng đó chỉ là hệ quả tự nhiên của việc copy địa chỉ: bản photo địa chỉ vẫn đưa bạn tới đúng căn nhà để sơn tường. **Sửa object qua reference** ≠ **thay đổi biến của người gọi** — Java chỉ làm được cái đầu.

> [!WARNING]
> Phát biểu đúng: *Java truyền **bản sao của reference**.* Bạn có thể **sửa nội dung** object qua bản sao reference đó (cùng địa chỉ heap), nhưng **gán lại** tham số chỉ đổi bản sao cục bộ — biến gốc ngoài method không hề thay đổi. Muốn "đổi" object cho người gọi: sửa nội dung nó (`set...`, `append...`), hoặc trả về object mới và để người gọi tự gán.

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
