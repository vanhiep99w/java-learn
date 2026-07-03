---
title: "String Internals — Deep Dive"
description: "Mổ xẻ String trong JVM: String Pool (intern()), Compact Strings (JDK 9+), immutability guarantee, String concatenation optimization (StringBuilder → invokedynamic), String deduplication G1 GC, == vs equals pitfalls. Kèm đọc source JDK, bytecode và benchmark."
---

## Mục lục

- [500MB heap toàn String trùng lặp](#1-500mb-heap-toàn-string-trùng-lặp)
- [Cấu trúc nội bộ — byte[] + coder (JDK 9+)](#2-cấu-trúc-nội-bộ--byte--coder-jdk-9)
- [Immutability — vì sao String là final + không đổi được](#3-immutability--vì-sao-string-là-final--không-đổi-được)
- [String Pool — intern() và constant pool](#4-string-pool--intern-và-constant-pool)
- [Compact Strings — LATIN1 vs UTF16, tiết kiệm 50% RAM](#5-compact-strings--latin1-vs-utf16-tiết-kiệm-50-ram)
- [String concatenation — từ StringBuilder đến invokedynamic](#6-string-concatenation--từ-stringbuilder-đến-invokedynamic)
- [== vs equals — khi nào == đúng, khi nào sai](#7--vs-equals--khi-nào--đúng-khi-nào-sai)
- [String Deduplication — G1 GC tự gộp string trùng](#8-string-deduplication--g1-gc-tự-gộp-string-trùng)
- [substring() — copy hay share? Thay đổi qua các JDK](#9-substring--copy-hay-share-thay-đổi-qua-các-jdk)
- [hashCode() caching — tại sao hash == 0 vẫn tính lại](#10-hashcode-caching--tại-sao-hash--0-vẫn-tính-lại)
- [Performance patterns & anti-patterns](#11-performance-patterns--anti-patterns)
- [Tóm tắt — Cheat sheet & 5 nguyên tắc](#12-tóm-tắt--cheat-sheet--5-nguyên-tắc)

---

## 1. 500MB heap toàn String trùng lặp

**String** trong JVM phức tạp hơn vẻ ngoài: `final` + **immutable** + backing `byte[]` với `coder` LATIN1/UTF16 (JDK 9+), cộng thêm **String Pool**, concatenation tối ưu bằng `invokedynamic`, và **G1 String Deduplication**. Mỗi cơ chế đó là một đòn bẩy tiết kiệm RAM — vì string thường chiếm 25–40% heap, hiểu internals là cách giảm hàng trăm MB mà không đổi logic code.

Service xử lý log có heap 2GB. Memory profiler: 40% heap = **`char[]`** (pre-JDK 9) / **`byte[]`** (JDK 9+). Top dominator: `String` objects — hàng triệu instance có cùng nội dung (`"INFO"`, `"ERROR"`, `"GET"`, `"/api/v1/users"`...).

```text
Heap dump analysis:
  String instances:           8,200,000
  Unique string values:         45,000    ← chỉ 0.5% là unique!
  Total char[]/byte[] memory:   512 MB
  After deduplication:           28 MB    ← tiết kiệm 94%
```

> [!IMPORTANT]
> String thường chiếm **25-40% heap** của Java application. Hiểu internals (pool, compact strings, dedup) là hiểu cách tiết kiệm hàng trăm MB RAM mà không đổi logic code.

Phần còn lại của doc sẽ đi qua: cấu trúc nội bộ byte[] + coder (§2) → immutability (§3) → String Pool & intern() (§4) → Compact Strings LATIN1 vs UTF16 (§5) → concatenation từ StringBuilder đến invokedynamic (§6) → == vs equals (§7) → G1 String Deduplication (§8) → substring copy hay share (§9) → hashCode caching (§10) → performance patterns & anti-patterns (§11) → cheat sheet (§12).

---

## 2. Cấu trúc nội bộ — byte[] + coder (JDK 9+)

### JDK 8 và trước:

```java
public final class String {
    private final char[] value;    // UTF-16: mỗi char = 2 bytes
    private int hash;              // cached hashCode (0 = chưa tính)
}
```

### JDK 9+ (Compact Strings):

```java
public final class String {
    @Stable
    private final byte[] value;    // LATIN1: 1 byte/char, hoặc UTF16: 2 bytes/char
    private final byte coder;      // LATIN1 = 0, UTF16 = 1
    private int hash;              // cached hashCode
    private boolean hashIsZero;    // JDK 15+: phân biệt "chưa tính" vs "hash đúng = 0"
}
```

**Memory layout** (64-bit JVM, compressed oops):

```
JDK 8:  String object (header 12B + char[] ref 4B + hash 4B + padding) = 24B
        + char[5] "Hello" (header 16B + 5×2B) = 26B → padded 32B
        Total: 24 + 32 = 56 bytes cho "Hello"

JDK 9+: String object (header 12B + byte[] ref 4B + coder 1B + hash 4B + hashIsZero 1B + padding) = 24B
        + byte[5] "Hello" (header 16B + 5×1B) = 21B → padded 24B
        Total: 24 + 24 = 48 bytes cho "Hello"  ← tiết kiệm 14%
```

> [!NOTE]
> `@Stable` annotation báo JIT compiler: field này không bao giờ đổi sau construction → JIT có thể constant-fold, inline giá trị trực tiếp vào generated code.

---

## 3. Immutability — vì sao String là final + không đổi được

```java
public final class String { ... }  // final → không thể extend
//         ^^^^^
private final byte[] value;        // final → reference không đổi sau construction
//             ^^^^^               // nhưng nội dung array CÓ THỂ đổi bằng reflection (!)
```

**3 lý do String bất biến:**

1. **String Pool an toàn**: nhiều reference trỏ cùng 1 String trong pool. Nếu mutable → đổi 1 ảnh hưởng tất cả.
2. **hashCode cache**: tính 1 lần, dùng mãi. Nếu nội dung đổi → hash sai → HashMap hỏng.
3. **Thread-safe miễn phí**: immutable object inherently thread-safe — không cần synchronization.

**Có thể phá bằng reflection không?**

```java
String s = "Hello";
Field valueField = String.class.getDeclaredField("value");
valueField.setAccessible(true);   // JDK 9+: InaccessibleObjectException (module system)
byte[] val = (byte[]) valueField.get(s);
val[0] = 'X';  // "Xello" — phá immutability!
// → Pool bị corrupt, mọi nơi dùng "Hello" giờ thấy "Xello"
```

> [!WARNING]
> JDK 9+ với module system **chặn** reflection vào `java.lang.String` fields mặc định. Cần `--add-opens java.base/java.lang=ALL-UNNAMED`. Đây là lý do module system tồn tại: bảo vệ invariant như String immutability.

---

## 4. String Pool — intern() và constant pool

### 4.1. Compile-time constant pool

Mọi **string literal** trong source code được lưu trong **constant pool** của `.class` file. Khi class load, JVM đưa chúng vào **String Pool** (interned strings):

```java
String a = "Hello";       // literal → pool
String b = "Hello";       // cùng literal → cùng reference từ pool
a == b;                    // true! cùng object

String c = new String("Hello");  // new → tạo object MỚI trên heap (không phải pool)
a == c;                    // false — khác object
a.equals(c);               // true — cùng nội dung
```

### 4.2. Runtime interning — intern()

```java
String runtime = new String("Hello");
String interned = runtime.intern();  // kiểm tra pool: có "Hello"? trả reference pool
interned == a;  // true — cùng reference với literal "Hello" trong pool
```

**String Pool ở đâu?**

| JDK version | Pool location | Consequence |
|-------------|---------------|-------------|
| JDK 6 | **PermGen** (fixed size) | OOM: PermGen nếu intern quá nhiều |
| JDK 7+ | **Main heap** | GC bình thường, co giãn theo heap |

```
JDK 7+: Pool là HashTable native (C++ level), bucket = linked list
-XX:StringTableSize=60013   (default, prime number)
-XX:+PrintStringTableStatistics   → xem occupancy khi exit
```

### 4.3. Khi nào nên/không nên intern()

| Nên | Không nên |
|-----|-----------|
| String lặp lại **rất nhiều** (country codes, status enums dạng string) | String unique (UUID, timestamp) — pool chỉ thêm overhead |
| Cần `==` thay `equals` cho tốc độ so sánh | Quá nhiều distinct values → pool trở thành memory leak |

> [!IMPORTANT]
> `intern()` tốn CPU (hash + lookup trong native table). Chỉ có lợi khi tiết kiệm memory > chi phí interning. Rule of thumb: chỉ intern string có **duplication ratio > 50%** và số distinct values < vài chục nghìn.

---

## 5. Compact Strings — LATIN1 vs UTF16, tiết kiệm 50% RAM

JDK 9 mặc định bật **Compact Strings** (`-XX:+CompactStrings`, default on):

```java
// String chỉ chứa ký tự ASCII/Latin1 (0x00 - 0xFF):
String ascii = "Hello World";   // coder = LATIN1, value = byte[11] (1 byte/char)

// String chứa ký tự ngoài Latin1 (tiếng Việt, CJK, emoji):
String vn = "Xin chào";        // coder = UTF16, value = byte[16] (2 bytes/char)
```

**Hành vi:**
- Khi TẤT CẢ ký tự fit trong 1 byte (codepoint ≤ 0xFF) → **LATIN1** encoding → 1 byte/char.
- Khi BẤT KỲ ký tự nào > 0xFF → **UTF16** encoding → 2 bytes/char cho toàn bộ string.
- Quyết định tại **construction time** — không đổi sau đó.

```java
// Benchmark: 1 triệu String "Hello" (5 chars)
// JDK 8:  5 × 2 bytes × 1M = 10 MB (char[])
// JDK 9+: 5 × 1 byte  × 1M =  5 MB (byte[], LATIN1)  ← tiết kiệm 50%
```

**Nhược điểm**: mỗi method (`charAt`, `length`, `substring`) phải check `coder` rồi branch:

```java
public char charAt(int index) {
    if (isLatin1())
        return StringLatin1.charAt(value, index);   // value[index] & 0xFF
    else
        return StringUTF16.charAt(value, index);    // (value[i*2] << 8) | value[i*2+1]
}
```

> [!NOTE]
> JIT compiler **profile** branch → nếu app toàn LATIN1 string, branch prediction gần như perfect → overhead gần zero. Ứng dụng quốc tế (CJK, emoji) vẫn chạy đúng nhưng không tiết kiệm memory cho những string đó.

---

## 6. String concatenation — từ StringBuilder đến invokedynamic

### 6.1. JDK 8: compiler sinh StringBuilder

```java
String s = "Hello " + name + "!";
// Bytecode (JDK 8):
// new StringBuilder().append("Hello ").append(name).append("!").toString()
```

### 6.2. JDK 9+: invokedynamic + StringConcatFactory

```java
String s = "Hello " + name + "!";
// Bytecode (JDK 9+):
// invokedynamic makeConcatWithConstants(name) ["Hello \1!"]
```

**Vì sao thay đổi?**

| | StringBuilder (JDK 8) | invokedynamic (JDK 9+) |
|-|----------------------|------------------------|
| Allocation | Tạo StringBuilder + resize nội bộ | JVM chọn strategy tối ưu runtime |
| Array copy | Có thể nhiều lần (grow) | Có thể tính trước exact size |
| Inlining | Khó (virtual calls) | JIT thấy full picture → aggressive optimization |
| Strategy | Cố định | Thay đổi được qua flag |

```java
// JVM strategies (-Djava.lang.invoke.stringConcat):
// MH_SB_SIZED:         StringBuilder pre-sized
// MH_SB_SIZED_EXACT:   StringBuilder exact size (no resize)
// MH_INLINE_SIZED_EXACT: byte[] exact size, no intermediate object (default JDK 9+)
```

### 6.3. Loop concatenation — vẫn cần StringBuilder

```java
// ❌ invokedynamic PER iteration → O(n²) total
String result = "";
for (String item : items) {
    result = result + item;  // mỗi lần tạo String mới, copy toàn bộ cũ
}

// ✅ StringBuilder thủ công cho loop
StringBuilder sb = new StringBuilder(estimatedSize);
for (String item : items) {
    sb.append(item);
}
String result = sb.toString();
```

> [!WARNING]
> Compiler **không** hoist StringBuilder ra ngoài loop. `result += item` trong vòng lặp vẫn là O(n²). Chỉ concatenation **flat** (1 expression, không loop) được tối ưu bởi invokedynamic.

---

## 7. == vs equals — khi nào == đúng, khi nào sai

```java
String a = "Hello";              // literal → pool
String b = "Hello";              // literal → cùng pool ref
String c = new String("Hello");  // new object, không phải pool
String d = c.intern();           // intern → trả pool ref

a == b;    // true  ← cùng pool reference
a == c;    // false ← c là object mới trên heap
a == d;    // true  ← d = interned = pool reference
a.equals(c); // true ← cùng nội dung
```

**Compile-time constant folding:**

```java
String x = "Hel" + "lo";   // compiler fold → "Hello" → pool
x == a;                     // true! compiler biết kết quả tại compile-time

final String prefix = "Hel";
String y = prefix + "lo";   // final → compiler fold → pool
y == a;                      // true

String z = prefix;           // không final → không fold
String w = z + "lo";        // runtime concat → new object
w == a;                      // false
```

> [!TIP]
> Rule đơn giản: **luôn dùng `.equals()`** để so sánh String content. Dùng `==` chỉ khi bạn **cố ý** kiểm tra identity (hiếm khi cần). Compiler/JIT optimization là implementation detail — đừng dựa vào nó.

---

## 8. String Deduplication — G1 GC tự gộp string trùng

G1 GC (JDK 8u20+) có feature **String Deduplication** (`-XX:+UseStringDeduplication`, default OFF):

```
Trước dedup:
  String A ("Hello") → byte[]{72,101,108,108,111}   ← object riêng
  String B ("Hello") → byte[]{72,101,108,108,111}   ← object riêng, cùng nội dung
  
Sau dedup:
  String A ("Hello") ──┐
                       ├──→ byte[]{72,101,108,108,111}   ← SHARE cùng array
  String B ("Hello") ──┘
```

**Cách hoạt động:**
1. G1 GC track String objects sống qua nhiều GC cycle (tuổi ≥ `StringDeduplicationAgeThreshold`, default 3).
2. So sánh `value` array content (hash-based).
3. Nếu trùng → **point** String B's `value` field sang array của A → GC free array cũ của B.

**Khác gì với `intern()`?**

| | `intern()` | String Deduplication |
|-|------------|---------------------|
| Level | Share **String object** | Share **byte[] array** (String objects vẫn riêng) |
| Khi nào | Explicit call | GC tự động (background) |
| `==` works? | ✅ (cùng object) | ❌ (khác object, share array) |
| Overhead | CPU khi intern | GC cycle thêm phase |

> [!NOTE]
> Deduplication **không ảnh hưởng** correctness hay semantics. Nó chỉ giảm memory footprint. Bật khi: (1) dùng G1 GC, (2) heap có nhiều String trùng, (3) muốn giảm RAM mà không đổi code. ZGC (JDK 15+) cũng hỗ trợ.

---

## 9. substring() — copy hay share? Thay đổi qua các JDK

### JDK 6 (share):

```java
// String giữ: char[] value, int offset, int count
// substring() share cùng char[] → tiết kiệm copy
String s = "Hello World";    // char[11]
String sub = s.substring(6); // share char[11], offset=6, count=5
```

**Bug nổi tiếng**: String gốc 1MB, substring 10 char → char[] 1MB vẫn sống vì substring reference nó → **memory leak**.

### JDK 7+ (copy):

```java
// substring() COPY phần cần thiết vào array mới
String s = "Hello World";     // byte[11]
String sub = s.substring(6);  // byte[5] MỚI, copy "World" → gốc GC-able
```

> [!IMPORTANT]
> Từ JDK 7, `substring()` luôn **copy**. Memory safe nhưng O(n) cho mỗi substring. Nếu cần slice không copy → dùng `CharSequence` wrapper hoặc `ByteBuffer`.

---

## 10. hashCode() caching — tại sao hash == 0 vẫn tính lại

```java
public int hashCode() {
    int h = hash;            // cached value
    if (h == 0 && !hashIsZero) {   // JDK 15+
        h = isLatin1() ? StringLatin1.hashCode(value) : StringUTF16.hashCode(value);
        if (h == 0) {
            hashIsZero = true;     // hash thực sự == 0, không tính lại
        } else {
            hash = h;              // cache
        }
    }
    return h;
}
```

**Trước JDK 15**: `hash = 0` được dùng làm sentinel "chưa tính". Nhưng empty string `""` và một số string khác thực sự có `hashCode() == 0`:

```java
"".hashCode();          // 0
"\\u0000".hashCode();    // 0 (null char)
// Polynomial collision cũng có thể cho 0
```

→ Mỗi lần gọi `hashCode()` trên string có hash == 0, **tính lại** vì không phân biệt được "chưa tính" vs "đã tính ra 0". JDK 15+ thêm `hashIsZero` boolean fix vấn đề này.

> [!NOTE]
> hashCode formula (polynomial rolling hash): `s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]`. Dùng 31 vì: (1) số nguyên tố lẻ, (2) `31 * i == (i << 5) - i` → JIT optimize thành shift + subtract.

---

## 11. Performance patterns & anti-patterns

| Pattern | Đúng/Sai | Lý do |
|---------|----------|-------|
| `"" + number` convert int to String | ❌ Chậm | Dùng `String.valueOf(number)` hoặc `Integer.toString(number)` |
| Concatenation trong loop | ❌ O(n²) | `StringBuilder` hoặc `String.join()` |
| `new String("literal")` | ❌ Vô nghĩa | Tạo copy thừa — dùng literal trực tiếp |
| `str.equals("constant")` | ⚠️ NPE risk | `"constant".equals(str)` — null-safe |
| `intern()` mọi string | ❌ Tốn CPU | Chỉ intern string có duplication ratio cao |
| `StringBuilder` không initial capacity | ⚠️ Resize | Estimate capacity: `new StringBuilder(expectedLength)` |
| `String.format()` trong hot path | ❌ Chậm (10-20x) | Dùng StringBuilder hoặc `+` concatenation |
| `str.isEmpty()` vs `str.length() == 0` | ✅ Equivalent | isEmpty() readable hơn, cùng tốc độ |

**Benchmark: concatenation methods (JDK 17, JMH)**:

```text
Method                          ns/op    Allocations
"a" + b + "c" (invokedynamic)   12.3     1 (exact-sized byte[])
StringBuilder(est).append(...)  14.1     2 (StringBuilder + toString)
String.format("%s%s%s", ...)    285.0    ~10 (Pattern, Formatter, ...)
MessageFormat.format(...)       490.0    ~15
```

---

## 12. Tóm tắt — Cheat sheet & 5 nguyên tắc

**Cỗ máy trong 6 dòng:**

```
1. String = final class, byte[] value (immutable), byte coder (LATIN1=0 / UTF16=1)
2. Literal → String Pool (interned). new String() → heap object mới
3. Compact Strings (JDK 9+): ASCII/Latin1 dùng 1 byte/char → tiết kiệm ~50% RAM
4. Concatenation (JDK 9+): invokedynamic → StringConcatFactory → exact-sized byte[]
5. hashCode() cached; substring() copies (JDK 7+); intern() dùng native HashTable
6. G1 String Dedup: share byte[] giữa String có cùng content — transparent, GC-driven
```

| Operation | Complexity | Allocation |
|-----------|-----------|------------|
| charAt(i) | O(1) | None |
| length() | O(1) | None |
| equals() | O(n) | None |
| hashCode() (first call) | O(n) | None (cached) |
| substring() | O(k) k=length | New byte[] |
| concat / + | O(n+m) | New String + byte[] |
| intern() | O(n) amortized | None (returns pool ref) |

**5 nguyên tắc khắc cốt:**

1. **Luôn dùng `.equals()` so sánh String** — `==` chỉ đúng ngẫu nhiên (pool/literal). Đừng dựa vào implementation detail.
2. **Loop concatenation → StringBuilder** — `+=` trong loop là O(n²). Compiler không hoist ra ngoài.
3. **String immutability là nền tảng** — pool, hashCode cache, thread-safety đều dựa vào nó. Phá bằng reflection = corrupt toàn hệ thống.
4. **Compact Strings miễn phí** (JDK 9+) — ASCII app tiết kiệm 50% string memory. Không cần làm gì.
5. **intern() có chi phí** — chỉ dùng khi duplication ratio cao VÀ số distinct values bounded. Nếu không → String Deduplication của G1 GC an toàn hơn.

> [!TIP]
> Một câu để nhớ: *String đơn giản bề ngoài nhưng là class phức tạp nhất trong JDK — pool, compact encoding, concat optimization, hash caching, GC dedup. Hiểu nó là hiểu cách JVM tối ưu thứ chiếm nhiều heap nhất.*
