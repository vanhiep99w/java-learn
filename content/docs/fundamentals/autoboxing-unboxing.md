---
title: "Autoboxing & Unboxing"
description: "Mổ xẻ autoboxing/unboxing trong Java: bytecode Integer.valueOf/intValue, Integer cache [-128,127] và bẫy ==, NullPointerException khi unbox null, chi phí allocation ẩn trong vòng lặp, vì sao Stream nên dùng IntStream. Kèm đọc bytecode javap và benchmark."
---

Autoboxing và unboxing cho phép Java chuyển đổi tự động giữa primitive và wrapper tương ứng. Cú pháp tiện lợi này che giấu việc tạo object, xử lý `null` và các quy tắc so sánh có thể ảnh hưởng đến hiệu năng lẫn tính đúng đắn.

## Mục lục

- [Tổng quan](#1-tổng-quan)
- [Autoboxing là gì — đường cong cú pháp của compiler](#2-autoboxing-là-gì--đường-cong-cú-pháp-của-compiler)
- [Đọc bytecode: valueOf & intValue ở đâu ra](#3-đọc-bytecode-valueof--intvalue-ở-đâu-ra)
- [Integer Cache & bẫy == kinh điển](#4-integer-cache--bẫy--kinh-điển)
- [NullPointerException khi unbox null](#5-nullpointerexception-khi-unbox-null)
- [Chi phí ẩn: allocation, GC và cache miss](#6-chi-phí-ẩn-allocation-gc-và-cache-miss)
- [Bẫy trong Collection, Map và ternary](#7-bẫy-trong-collection-map-và-ternary)
- [Stream: vì sao IntStream tồn tại](#8-stream-vì-sao-intstream-tồn-tại)
- [Khi nào buộc phải dùng wrapper](#9-khi-nào-buộc-phải-dùng-wrapper)
- [Anti-patterns cần tránh](#10-anti-patterns-cần-tránh)
- [Tóm tắt — Cheat sheet & nguyên tắc](#11-tóm-tắt--cheat-sheet--nguyên-tắc)

---

## 1. Tổng quan

Compiler chèn lời gọi như `Integer.valueOf()` khi boxing và `intValue()` khi unboxing. Vì wrapper có thể là `null`, unboxing có thể ném `NullPointerException`; vì một số giá trị được cache, so sánh wrapper bằng `==` có thể cho kết quả không nhất quán theo giá trị.

Trong collection và generic API, boxing là bắt buộc vì type argument không thể là primitive. Cần nhận biết chi phí này trong vòng lặp lớn và đường xử lý nhạy cảm với allocation.

## 2. Autoboxing là gì — đường cong cú pháp của compiler

Java có **8 kiểu nguyên thủy** (`int`, `long`, `double`, `boolean`, ...) và **8 lớp wrapper** tương ứng (`Integer`, `Long`, `Double`, `Boolean`, ...). Nguyên thủy nằm trên stack/inline, wrapper là **object trên heap**.

| | Nguyên thủy | Wrapper |
|---|-------------|---------|
| Lưu trữ | Stack / inline trong object | Object trên heap (có header 12–16 byte) |
| `null` | Không thể | Có thể |
| So sánh | `==` so **giá trị** | `==` so **reference**, `equals` so giá trị |
| Generic | Không dùng được (`List<int>` ✗) | Bắt buộc (`List<Integer>` ✓) |

- **Autoboxing**: tự chuyển nguyên thủy → wrapper (`Integer x = 5;`).
- **Unboxing**: tự chuyển wrapper → nguyên thủy (`int y = x;`).

Đây thuần túy là **syntactic sugar** (Java 5+). JVM **không** biết autoboxing — compiler `javac` chèn lời gọi method tường minh vào bytecode. JVM chỉ thấy `Integer.valueOf(int)` và `Integer.intValue()`.

---

## 3. Đọc bytecode: valueOf & intValue ở đâu ra

Cách chắc chắn nhất để hiểu là nhìn bytecode. Cho đoạn:

```java
Integer boxed = 42;       // autobox
int unboxed = boxed;      // unbox
```

`javap -c` cho ra:

```text
0: bipush        42
2: invokestatic  Integer.valueOf:(I)Ljava/lang/Integer;   // ← autobox = valueOf
5: astore_1
6: aload_1
7: invokevirtual Integer.intValue:()I                     // ← unbox = intValue
10: istore_2
```

Quy tắc dịch của compiler:

| Cú pháp bạn viết | Compiler chèn |
|------------------|---------------|
| `Integer i = 42;` | `Integer.valueOf(42)` |
| `int n = i;` | `i.intValue()` |
| `Long l = 5L;` | `Long.valueOf(5L)` |
| `Double d = 1.0;` | `Double.valueOf(1.0)` |
| `Boolean b = true;` | `Boolean.valueOf(true)` |

Điểm mấu chốt: **autobox dùng `valueOf`, KHÔNG dùng `new`**. Và `valueOf` chính là nơi có **cache** (mục 4). Nếu bạn tự viết `new Integer(42)` (đã deprecated từ Java 9, xóa dần) thì **bỏ qua cache** và luôn tạo object mới.

> [!NOTE]
> Vì autobox = gọi method, mỗi lần box **có thể** tạo object (nếu ngoài cache). Trong vòng lặp nóng, "có thể" trở thành "hàng triệu lần" như mục 1.

---

## 4. Integer Cache & bẫy == kinh điển

`Integer.valueOf` không tạo object mới cho số nhỏ — nó trả về từ một **cache tĩnh** dựng sẵn:

```java
public static Integer valueOf(int i) {
    if (i >= IntegerCache.low && i <= IntegerCache.high)
        return IntegerCache.cache[i + (-IntegerCache.low)];   // dùng lại object có sẵn
    return new Integer(i);                                    // ngoài cache → object mới
}
```

`IntegerCache` dựng sẵn các `Integer` từ **-128 đến 127** lúc class load. Hệ quả là bẫy `==` nổi tiếng:

```java
Integer a = 100, b = 100;
System.out.println(a == b);    // true  — cùng object trong cache

Integer c = 200, d = 200;
System.out.println(c == d);    // false — 200 ngoài cache → 2 object khác nhau
System.out.println(c.equals(d)); // true — equals so GIÁ TRỊ
```

```
valueOf(100): cache[-128..127] có sẵn → cùng reference  → == true
valueOf(200): ngoài [-128,127]        → new Integer mỗi lần → == false
```

> [!WARNING]
> **Không bao giờ** dùng `==` để so hai wrapper. Nó "tình cờ đúng" với số nhỏ rồi sai im lặng với số lớn — loại bug chỉ nổ trên production với dữ liệu thật. Luôn dùng `.equals()` hoặc unbox về nguyên thủy trước khi so.

Chi tiết cache theo từng kiểu:

| Wrapper | Khoảng cache | Chỉnh được? |
|---------|--------------|-------------|
| `Integer` | -128 .. 127 (mặc định) | Có: `-XX:AutoBoxCacheMax=N` (nới trần trên) |
| `Long` | -128 .. 127 | Không |
| `Short`, `Byte` | -128 .. 127 | Không |
| `Character` | 0 .. 127 | Không |
| `Boolean` | `TRUE`, `FALSE` | Luôn cache |
| `Float`, `Double` | **Không cache** (mọi giá trị → object mới) | — |

> [!TIP]
> `-XX:AutoBoxCacheMax=1000` mở rộng cache `Integer` tới 1000 — đôi khi dùng để giảm allocation cho hệ thống thao tác nhiều số nhỏ. Nhưng đừng dựa vào nó cho tính đúng đắn; nó chỉ là tinh chỉnh hiệu năng.

---

## 5. NullPointerException khi unbox null

Wrapper có thể `null`. Khi unbox `null`, compiler chèn `.intValue()` trên `null` → **NPE** ở chỗ chẳng có dấu hiệu gì:

```java
Map<String, Integer> counts = new HashMap<>();
int n = counts.get("missing");    // get trả null → null.intValue() → NPE 💥
```

NPE này đặc biệt khó debug vì dòng code **không có** dereference nào nhìn thấy được — phép unbox là ẩn.

Các nguồn null-unbox phổ biến:

```java
Integer maybe = repo.findCount();        // có thể null từ DB
if (maybe == 5) { ... }                  // unbox maybe → NPE nếu null

boolean flag = config.getBoolean("on");  // trả Boolean, có thể null → NPE
long id = dto.getId();                    // getId() trả Long null → NPE

int x = true ? null : 0;                 // ternary unbox cả 2 nhánh → NPE (mục 7)
```

> [!IMPORTANT]
> Mọi lần một `Integer`/`Long`/`Boolean` có thể `null` được gán vào nguyên thủy, so sánh `==` với nguyên thủy, hoặc dùng trong toán tử số học → đó là một quả mìn NPE. Phòng bằng `Objects.requireNonNullElse(v, 0)`, `getOrDefault`, hoặc `Optional`.

---

## 6. Chi phí ẩn: allocation, GC và cache miss

Wrapper đắt hơn nguyên thủy theo **ba** trục, không chỉ "tốn RAM":

**1. Kích thước.** Một `int` là 4 byte. Một `Integer` là object: header (12–16 byte) + field `int` (4 byte) + padding → ~16 byte, **cộng** 4–8 byte cho reference trỏ tới nó. Gấp ~4–5 lần.

**2. Cache locality.** `int[]` là khối liền mạch, CPU prefetch tuyến tính. `Integer[]` là **mảng reference** trỏ tới các object rải rác khắp heap → mỗi truy cập là một lần **pointer chasing**, dễ **cache miss**:

```
int[]:      [42][43][44][45]            ← liền mạch, prefetch tốt
Integer[]:  [ref][ref][ref][ref]        ← mảng con trỏ
              │    │    │    │
              ▼    ▼    ▼    ▼
            {42} {43} {44} {45}         ← object rải rác → cache miss
```

**3. Allocation/GC.** Box trong vòng lặp tạo rác liên tục (mục 1), gây áp lực GC young-gen.

> [!CAUTION]
> Escape analysis của JIT **đôi khi** loại được box tạm thời (scalar replacement) nếu object không "thoát" khỏi method. Nhưng đừng phụ thuộc — nó dễ vỡ khi object thoát ra (vào collection, trả về, gán field). Cách chắc chắn: dùng nguyên thủy ngay từ đầu.

---

## 7. Bẫy trong Collection, Map và ternary

**Generic ép buộc box.** Collection không chứa nguyên thủy → `List<Integer>` box mọi phần tử:

```java
List<Integer> list = new ArrayList<>();
for (int i = 0; i < 1_000_000; i++) list.add(i);  // 1 triệu lần valueOf
int total = 0;
for (int v : list) total += v;                     // 1 triệu lần intValue
```

→ Với dữ liệu số lớn, cân nhắc thư viện primitive collection (Eclipse Collections, fastutil) hoặc mảng nguyên thủy.

**`remove(int)` vs `remove(Integer)` — overload trap:**

```java
List<Integer> list = new ArrayList<>(List.of(10, 20, 30));
list.remove(1);            // remove theo INDEX → xóa phần tử vị trí 1 (giá trị 20)
list.remove((Integer) 1);  // remove theo OBJECT → xóa phần tử có giá trị 1 (không có)
```

`List` có cả `remove(int index)` và `remove(Object o)`. Truyền `int` chọn overload **index** — không hề autobox. Phải cast `(Integer)` để xóa theo giá trị.

**Ternary unbox cả hai nhánh:**

```java
Integer result = condition ? getValue() : null;   // getValue() trả int
```

Nếu một nhánh là nguyên thủy và nhánh kia là wrapper, compiler **unbox cả hai về nguyên thủy** rồi box lại → nếu nhánh `null` được chọn → NPE. Đây là một trong những NPE khó hiểu nhất.

> [!WARNING]
> Quy tắc ternary: nếu hai nhánh có kiểu `int` và `Integer`, kết quả là `int` — nhánh `Integer` bị unbox. `cond ? 1 : nullableInteger` sẽ NPE khi `nullableInteger == null`.

---

## 8. Stream: vì sao IntStream tồn tại

`Stream<Integer>` box mọi phần tử. JDK cung cấp **stream nguyên thủy chuyên dụng** — `IntStream`, `LongStream`, `DoubleStream` — để tránh box hoàn toàn:

```java
// ❌ Stream<Integer> — box từng phần tử, sum() phải unbox lại
int s1 = list.stream().reduce(0, Integer::sum);

// ✅ IntStream — không box, sum() trả int trực tiếp
int s2 = list.stream().mapToInt(Integer::intValue).sum();

// ✅ tạo dải số không box
int s3 = IntStream.rangeClosed(1, 1_000_000).sum();
```

Các cầu nối quan trọng:

| Hướng | Method |
|-------|--------|
| `Stream<Integer>` → `IntStream` | `.mapToInt(Integer::intValue)` |
| `IntStream` → `Stream<Integer>` | `.boxed()` |
| Thu thập thống kê không box | `.summaryStatistics()` (count/sum/min/max/avg) |

> [!TIP]
> Khi xử lý lượng lớn số, `mapToInt(...).sum()` thay vì `map(...).reduce(...)` loại bỏ hàng triệu lần box và thường nhanh gấp nhiều lần. `IntStream.range` cũng không sinh object nào.

---

## 9. Khi nào buộc phải dùng wrapper

Wrapper không phải lúc nào cũng xấu — có chỗ **bắt buộc**:

| Tình huống | Vì sao cần wrapper |
|-----------|---------------------|
| Generic / collection | `List<Integer>`, `Map<String, Long>` — generic không nhận nguyên thủy |
| Cần biểu diễn "vắng giá trị" | DB column nullable → `Integer` để phân biệt `0` và `NULL` |
| API nhận `Object` | Reflection, framework, serialization |
| Method tiện ích | `Integer.parseInt`, `Integer.MAX_VALUE`, `Long.compare` |

> [!NOTE]
> Trong JPA/Hibernate, field nullable nên là `Integer`/`Long` chứ không phải `int`/`long`: nguyên thủy không thể `null`, nên một cột NULL sẽ thành `0` (sai dữ liệu) hoặc ném lỗi map. Đây là một trường hợp wrapper **đúng** về mặt ngữ nghĩa.

---

## 10. Anti-patterns cần tránh

| Anti-pattern | Vì sao sai | Thay bằng |
|--------------|-----------|-----------|
| Biến tích lũy là `Long`/`Integer` trong vòng lặp | Box mỗi vòng → hàng triệu object | Dùng nguyên thủy `long`/`int` |
| `==` so hai wrapper | Đúng với số nhỏ (cache), sai số lớn | `.equals()` hoặc unbox |
| Gán `map.get()` thẳng vào `int` | NPE nếu key vắng (null unbox) | `getOrDefault`, check null |
| `Stream<Integer>` cho khối số lớn | Box từng phần tử | `IntStream`/`mapToInt` |
| `list.remove(intValue)` định xóa theo giá trị | Gọi nhầm overload `remove(index)` | `list.remove((Integer) v)` |
| `new Integer(x)` | Bỏ qua cache, luôn tạo object (deprecated) | `Integer.valueOf(x)` / autobox |
| Field nullable khai `int` trong entity | NULL thành 0, sai dữ liệu | `Integer` cho cột nullable |

---

## 11. Tóm tắt — Cheat sheet & nguyên tắc

**Cỗ máy trong 5 dòng:**

```
1. autobox  = compiler chèn Integer.valueOf()  (CÓ cache [-128,127])
2. unbox    = compiler chèn x.intValue()       (null → NullPointerException)
3. == trên wrapper = so REFERENCE → bẫy cache; luôn .equals() / unbox
4. box trong vòng lặp = hàng triệu object rác → dùng nguyên thủy
5. khối số lớn → IntStream/LongStream, primitive array
```

| | Nguyên thủy | Wrapper |
|---|-------------|---------|
| Dùng cho | tính toán, vòng lặp, biến cục bộ | generic, collection, giá trị nullable |
| Chi phí | ~0 | header + reference + GC + cache miss |
| `==` | so giá trị (an toàn) | so reference (nguy hiểm) |

**5 nguyên tắc khắc cốt:**

1. **Mặc định nguyên thủy** — chỉ dùng wrapper khi generic/null bắt buộc.
2. **Không bao giờ `==` hai wrapper** — luôn `.equals()` hoặc unbox.
3. **Coi mọi unbox là NPE tiềm năng** — wrapper có thể `null`.
4. **Vòng lặp nóng = nguyên thủy** — một chữ `L`/`Integer` lạc chỗ tạo hàng triệu rác.
5. **Số lượng lớn → `IntStream`/primitive collection** — tránh box hàng loạt.

> [!TIP]
> Một câu để nhớ: *Autoboxing là phép màu của compiler — và như mọi phép màu, nó tính phí ở chỗ bạn không nhìn thấy.* Khi nghi ngờ hiệu năng hay NPE, hãy `javap -c` để xem `valueOf`/`intValue` compiler đã lén chèn vào đâu.
