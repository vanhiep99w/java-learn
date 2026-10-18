---
title: "Stream API"
description: "Mổ xẻ Stream API Java: lazy evaluation pipeline, Spliterator, intermediate/terminal operations, parallel stream & ForkJoinPool, short-circuiting, collector internals, và performance pitfalls. Kèm benchmark, diagram pipeline, và anti-patterns."
---

Stream API biểu diễn quá trình xử lý dữ liệu dưới dạng pipeline gồm source, các intermediate operation và một terminal operation. Nó hướng tới composition và tính khai báo, không phải mặc định nhanh hơn vòng lặp.

## Mục lục

- [Tổng quan](#1-tổng-quan)
- [Stream Pipeline Architecture — Source, Intermediate, Terminal](#2-stream-pipeline-architecture--source-intermediate-terminal)
- [Lazy Evaluation — không gì chạy cho tới terminal](#3-lazy-evaluation--không-gì-chạy-cho-tới-terminal)
- [Spliterator — nền tảng split & traverse](#4-spliterator--nền-tảng-split--traverse)
- [Intermediate Operations — stateless vs stateful](#5-intermediate-operations--stateless-vs-stateful)
- [Terminal Operations — trigger pipeline execution](#6-terminal-operations--trigger-pipeline-execution)
- [Short-circuiting — dừng sớm, không xử lý hết](#7-short-circuiting--dừng-sớm-không-xử-lý-hết)
- [Collector Internals — supplier, accumulator, combiner, finisher](#8-collector-internals--supplier-accumulator-combiner-finisher)
- [Parallel Stream — ForkJoinPool & splitting strategy](#9-parallel-stream--forkjoinpool--splitting-strategy)
- [Khi nào parallel nhanh hơn, khi nào chậm hơn](#10-khi-nào-parallel-nhanh-hơn-khi-nào-chậm-hơn)
- [Stream vs Loop — performance so sánh thực tế](#11-stream-vs-loop--performance-so-sánh-thực-tế)
- [Anti-patterns & production pitfalls](#12-anti-patterns--production-pitfalls)
- [Tóm tắt — Cheat sheet & 5 nguyên tắc](#13-tóm-tắt--cheat-sheet--5-nguyên-tắc)

---

## 1. Tổng quan

Intermediate operation thường được đánh giá lười và chỉ chạy khi terminal operation yêu cầu kết quả. Pipeline có thể hợp nhất nhiều bước, dừng sớm và trong điều kiện phù hợp được chia cho parallel execution.

Hiệu năng phụ thuộc vào nguồn dữ liệu, stateful operation, boxing, allocation và chi phí chia task. Vì vậy cần hiểu cơ chế pipeline trước khi quyết định dùng stream tuần tự hay song song.

## 2. Stream Pipeline Architecture — Source, Intermediate, Terminal

```d2 title="2. Stream Pipeline Architecture — Source, Intermediate, Terminal"
direction: right
n_SRC: "Source\n(Collection, array, generator)"
n_I1: "filter()"
n_I2: "map()"
n_I3: "sorted()"
n_T: "collect() / sum() / forEach()"
n_SRC -> n_I1
n_I1 -> n_I2
n_I2 -> n_I3
n_I3 -> n_T
n_SRC.style.fill: "#4ecdc4"
n_T.style.fill: "#ff6b6b"
```

| Component | Vai trò | Ví dụ |
|-----------|---------|-------|
| **Source** | Cung cấp elements | `list.stream()`, `Stream.of()`, `IntStream.range()` |
| **Intermediate** | Biến đổi stream → stream mới (lazy) | `filter`, `map`, `flatMap`, `sorted`, `distinct` |
| **Terminal** | Trigger execution, produce result | `collect`, `forEach`, `reduce`, `count`, `findFirst` |

**Đặc tính quan trọng:**
- Stream **không lưu trữ** data — nó là **pipeline** qua data source
- Stream **consumed một lần** — không thể reuse sau terminal operation
- Intermediate ops **lazy** — chỉ chạy khi terminal được gọi

---

## 3. Lazy Evaluation — không gì chạy cho tới terminal

```java
Stream<String> stream = list.stream()
    .filter(s -> {
        System.out.println("filter: " + s);  // KHÔNG in gì!
        return s.length() > 3;
    })
    .map(s -> {
        System.out.println("map: " + s);     // KHÔNG in gì!
        return s.toUpperCase();
    });
// Tới đây: CHƯA có gì chạy. Chỉ build pipeline description.

List<String> result = stream.collect(Collectors.toList());
// BÂY GIỜ mới chạy filter + map cho từng element
```

**Internal**: mỗi intermediate op tạo một **stage** (AbstractPipeline node). Các stages liên kết thành **linked list**:

```d2 title="3. Lazy Evaluation — không gì chạy cho tới terminal"
direction: right
head: "Head: AbstractPipeline\nspliterator=source, sourceFlags"
filter: "FilterOp: AbstractPipeline\npreviousStage=Head, opFlags"
map: "MapOp: AbstractPipeline\npreviousStage=FilterOp, opFlags"
terminal: "Terminal: collect"
head -> filter -> map -> terminal
filter -> head: previousStage { style.stroke-dash: 3 }
map -> filter: previousStage { style.stroke-dash: 3 }
```

### 3.1. Sink chain — wrapSink mechanism

Khi terminal operation trigger, JVM **wrap ngược** pipeline thành Sink chain:

```java
// Simplified terminal execution:
// 1. Wrap stages thành Sink chain (build từ cuối → đầu):
Sink<T> pipeline = terminalOp.makeSink();         // cuối
pipeline = mapStage.wrapSink(pipeline);            // map → delegate to collect
pipeline = filterStage.wrapSink(pipeline);         // filter → delegate to map

// 2. Push elements qua Sink chain:
pipeline.begin(size);
spliterator.forEachRemaining(pipeline::accept);    // source push vào filter
pipeline.end();
```

```d2 title="3.1. Sink chain — wrapSink mechanism"
direction: right
source: "Source.forEachRemaining(element)"
filter: "Filter.accept(element)"
pass: "Predicate pass?"
map: "Map.accept(element)"
collect: "Collect.accept(transformed)"
skip: "Bỏ element, lấy element kế tiếp"
source -> filter -> pass
pass -> map: Có
map -> collect
pass -> skip: Không
```

Mỗi Sink có 3 method: `begin(size)`, `accept(element)`, `end()` — cho phép short-circuit (vd `limit(5)` reject sau 5 accept) và stateful ops (vd `sorted()` buffer tất cả trong `accept`, emit trong `end`).

Terminal op **pull** element từ source qua từng stage:

```d2 title="Stream fusion: xử lý từng element qua các stage"
direction: down
source: "Terminal.forEachRemaining()\nfor each element from source"
filter: "filter stage: pass / skip" {shape: diamond}
map: "map stage: transform"
collect: "collect stage: accumulate"
next: "element tiếp theo / kết thúc"
source -> filter
filter -> map: "pass"
filter -> next: "skip"
map -> collect -> next
```

**Loop fusion**: JVM xử lý **từng element qua toàn bộ pipeline** trước khi lấy element tiếp. Không tạo collection trung gian giữa các stage:

```d2 title="Mỗi element đi trọn pipeline"
direction: right
r0n0: "Element 1: source"
r0n1: "filter ✓"
r0n2: "map"
r0n3: "collect"
r0n0 -> r0n1
r0n1 -> r0n2
r0n2 -> r0n3
r1n0: "Element 2: source"
r1n1: "filter ✗ (skip)"
r1n0 -> r1n1
r2n0: "Element 3: source"
r2n1: "filter ✓"
r2n2: "map"
r2n3: "collect"
r2n0 -> r2n1
r2n1 -> r2n2
r2n2 -> r2n3
```

> [!TIP]
> Loop fusion = cache-friendly (element nóng trong L1 cache được xử lý xong trước khi chuyển sang element khác). Đây là lý do stream thường **không chậm hơn** hand-written loop dù có abstraction overhead.

---

## 4. Spliterator — nền tảng split & traverse

`Spliterator<T>` (Splittable Iterator) là abstraction cho phép stream **traverse** và **split** data source:

```java
public interface Spliterator<T> {
    boolean tryAdvance(Consumer<? super T> action);  // xử lý 1 element
    Spliterator<T> trySplit();                       // chia đôi → 2 Spliterator
    long estimateSize();                             // ước lượng số element còn lại
    int characteristics();                           // ORDERED, SIZED, SORTED, ...
}
```

### 4.1. Characteristics

| Flag | Ý nghĩa | Source có |
|------|---------|-----------|
| `SIZED` | Biết chính xác số element | ArrayList, array |
| `ORDERED` | Có thứ tự xác định | List, LinkedHashSet |
| `SORTED` | Đã sort theo comparator | TreeSet |
| `DISTINCT` | Không duplicate | Set |
| `SUBSIZED` | Mỗi split đều SIZED | ArrayList, array |
| `NONNULL` | Không có null | ConcurrentHashMap |

### 4.2. Split quality ảnh hưởng parallel performance

```d2 title="Chi phí split ảnh hưởng parallel stream"
direction: right
r0n0: "ArrayList Spliterator: chia index /2"
r0n1: "2 nửa bằng nhau"
r0n2: "balanced work"
r0n3: "parallel hiệu quả"
r0n0 -> r0n1
r0n1 -> r0n2
r0n2 -> r0n3
r1n0: "LinkedList Spliterator: duyệt tới giữa O(n)"
r1n1: "split đắt + unbalanced"
r1n2: "parallel kém"
r1n0 -> r1n1
r1n1 -> r1n2
```

| Data Source | Split quality | Parallel effectiveness |
|-------------|--------------|----------------------|
| `ArrayList` / array | **Tuyệt vời** (index split) | Rất tốt |
| `IntStream.range()` | **Tuyệt vời** | Rất tốt |
| `HashSet` / `HashMap` | Tốt (bucket split) | Tốt |
| `LinkedList` | **Tệ** (O(n) traverse) | Thường chậm hơn sequential |
| `TreeSet` / `TreeMap` | Trung bình | Tốt |
| `Stream.iterate()` | **Tệ** (sequential dependency) | Không nên parallel |
| `BufferedReader.lines()` | Trung bình | Tuỳ file size |

> [!IMPORTANT]
> Parallel stream effectiveness phụ thuộc **chất lượng Spliterator.trySplit()**. Nếu source không split đều → thread bị imbalance → chậm hơn sequential. Luôn kiểm tra data source trước khi `parallelStream()`.

---

## 5. Intermediate Operations — stateless vs stateful

### 5.1. Stateless (mỗi element xử lý độc lập)

| Operation | Mô tả |
|-----------|--------|
| `filter(Predicate)` | Giữ element thoả điều kiện |
| `map(Function)` | Biến đổi element |
| `flatMap(Function)` | 1 element → nhiều elements (flatten) |
| `peek(Consumer)` | Side-effect (debug) — không đổi stream |
| `mapToInt/Long/Double` | Unbox sang primitive stream |

**Đặc điểm**: không cần biết element khác, xử lý hoàn toàn song song.

### 5.2. Stateful (cần biết/buffer nhiều element)

| Operation | Mô tả | Cost |
|-----------|--------|------|
| `sorted()` | Sort toàn bộ | O(n log n) + buffer toàn bộ |
| `distinct()` | Loại duplicate | O(n) HashSet buffer |
| `limit(n)` | Lấy n element đầu | Short-circuit nhưng cần ordering |
| `skip(n)` | Bỏ n element đầu | Phải đếm |

```d2 title="5.2. Stateful (cần biết/buffer nhiều element)"
direction: down
n_A: "stateless ops\nfilter, map, flatMap"
n_B: "stateful ops\nsorted, distinct"
n_PA: "Mỗi thread xử lý chunk riêng"
n_PB: "Phải merge/buffer trước khi tiếp"
n_A -> n_PA: "Parallel: perfect split"
n_B -> n_PB: "Parallel: barrier"
```

> [!WARNING]
> `sorted()` là **barrier** trong parallel stream: phải thu thập **toàn bộ** element trước khi sort. Nếu pipeline có `sorted()` → parallel benefit giảm đáng kể cho phần pipeline **sau** sorted (vì phải chờ barrier).

---

## 6. Terminal Operations — trigger pipeline execution

| Operation | Return | Short-circuit? |
|-----------|--------|---------------|
| `collect(Collector)` | Container (List, Map, ...) | Không |
| `reduce(identity, op)` | Single value | Không |
| `forEach(Consumer)` | void | Không |
| `count()` | long | Không* |
| `toList()` (JDK 16+) | Unmodifiable List | Không |
| `findFirst()` | Optional | **Có** |
| `findAny()` | Optional | **Có** |
| `anyMatch(Predicate)` | boolean | **Có** |
| `allMatch(Predicate)` | boolean | **Có** |
| `min()` / `max()` | Optional | Không |

*`count()` với SIZED source có thể optimize thành O(1) (JDK 9+):

```java
// JDK 9+: nếu stream chưa bị filter/flatMap → trả size trực tiếp
long n = list.stream().count();    // O(1) — không iterate
long m = list.stream().filter(x -> x > 0).count();  // O(n) — phải filter
```

---

## 7. Short-circuiting — dừng sớm, không xử lý hết

```java
Optional<String> found = hugeList.stream()   // 10M elements
    .filter(s -> s.startsWith("XYZ"))
    .findFirst();                             // dừng ngay khi tìm thấy 1 element
// Có thể chỉ xử lý 100 elements thay vì 10M
```

Short-circuit ops (`findFirst`, `findAny`, `anyMatch`, `limit`) signal upstream **"đủ rồi, dừng"**. Pipeline ngừng pull element từ source.

```d2 title="findFirst cancel sau phần tử đầu qua filter"
grid-rows: 4
grid-columns: 2
n0: "Source a"
n1: "Filter a ✗"
n3: "Filter b ✗"
n2: "Source b"
n4: "Source c"
n5: "Filter c ✓ → pass downstream"
n7: "d, e, f, g… KHÔNG được xử lý"
n6: "findFirst nhận c → DONE\ncancel pipeline"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
n4 -> n5
n5 -> n6
n6 -> n7
```

**Parallel + short-circuit**: `findAny` hiệu quả hơn `findFirst` trong parallel vì không cần maintain ordering — thread nào tìm thấy đầu tiên thì dùng.

---

## 8. Collector Internals — supplier, accumulator, combiner, finisher

`Collector<T, A, R>` định nghĩa **cách** thu thập stream elements vào container:

```java
public interface Collector<T, A, R> {
    Supplier<A> supplier();            // tạo container mới (vd: new ArrayList<>())
    BiConsumer<A, T> accumulator();    // thêm 1 element vào container
    BinaryOperator<A> combiner();     // merge 2 container (parallel)
    Function<A, R> finisher();         // biến đổi cuối (A → R)
    Set<Characteristics> characteristics(); // CONCURRENT, UNORDERED, IDENTITY_FINISH
}
```

### 8.1. Ví dụ: Collectors.toList()

```java
Collector.of(
    ArrayList::new,              // supplier: tạo ArrayList mới
    ArrayList::add,             // accumulator: add element
    (left, right) -> {          // combiner: merge 2 list (parallel)
        left.addAll(right);
        return left;
    }
    // finisher: identity (ArrayList là List rồi)
);
```

### 8.2. Parallel collector flow

```d2 title="8.2. Parallel collector flow"
direction: down
n_S: "Stream (parallel)"
n_T1: "Thread 1: supplier() → acc A"
n_T2: "Thread 2: supplier() → acc B"
n_T3: "Thread 3: supplier() → acc C"
n_A1: "A: [1,2,3]"
n_A2: "B: [4,5,6]"
n_A3: "C: [7,8,9]"
n_M1: "combiner(A, B) → [1,2,3,4,5,6]"
n_M2: "combiner(AB, C) → [1..9]"
n_F: "finisher() → result"
n_S -> n_T1
n_S -> n_T2
n_S -> n_T3
n_T1 -> n_A1: "accumulate chunk 1"
n_T2 -> n_A2: "accumulate chunk 2"
n_T3 -> n_A3: "accumulate chunk 3"
n_A1 -> n_M1
n_A2 -> n_M1
n_M1 -> n_M2
n_A3 -> n_M2
n_M2 -> n_F
```

### 8.3. Custom Collector ví dụ: group by + stats

```java
// Tính average amount per status
Map<Status, Double> avgByStatus = transactions.stream()
    .collect(Collectors.groupingBy(
        Transaction::status,
        Collectors.averagingLong(Transaction::amount)
    ));

// Custom: collect vào StringBuilder (nhanh hơn Collectors.joining cho large stream)
Collector<String, StringBuilder, String> fastJoin = Collector.of(
    StringBuilder::new,
    (sb, s) -> sb.append(s).append(","),
    StringBuilder::append,
    sb -> sb.length() > 0 ? sb.substring(0, sb.length()-1) : ""
);
```

---

## 9. Parallel Stream — ForkJoinPool & splitting strategy

### 9.1. Execution model

Parallel stream mặc định chạy trên **`ForkJoinPool.commonPool()`** (size = CPU cores - 1):

```java
// Mặc định: commonPool
list.parallelStream().forEach(this::process);

// Custom pool (nếu cần isolate):
ForkJoinPool custom = new ForkJoinPool(16);
custom.submit(() -> 
    list.parallelStream().forEach(this::process)
).join();
```

### 9.2. Fork-Join splitting

```d2 title="Parallel stream: split, process và merge"
direction: down
all: "[1,2,3,4,5,6,7,8]"
splitLeft: "[1,2,3,4]"
splitRight: "[5,6,7,8]"
a: "[1,2]: process"
b: "[3,4]: process"
c: "[5,6]: process"
d: "[7,8]: process"
ml: "merge trái (join)"
mr: "merge phải (join)"
result: "final result"
all -> splitLeft: "trySplit: nửa fork, nửa local"
all -> splitRight: "trySplit"
splitLeft -> a: "trySplit tới threshold"
splitLeft -> b: "trySplit"
splitRight -> c: "trySplit tới threshold"
splitRight -> d: "trySplit"
a -> ml
b -> ml
c -> mr
d -> mr
ml -> result: "merge (join)"
mr -> result: "merge (join)"
```

### 9.3. N-Q model (khi nào parallel đáng)

**N** = số elements, **Q** = cost per element

Parallel có lợi khi **N × Q** đủ lớn để bù overhead (fork/join/merge + thread communication):

| N | Q (per-element cost) | Parallel? |
|---|---------------------|-----------|
| 10.000+ | Cao (I/O, computation) | **Có** |
| 10.000+ | Thấp (simple compare) | Tuỳ (benchmark) |
| < 1.000 | Bất kỳ | **Không** (overhead > benefit) |
| 1M+ | Trung bình+ | **Gần như luôn** |

---

## 10. Khi nào parallel nhanh hơn, khi nào chậm hơn

### 10.1. Parallel nhanh hơn ✓

```java
// ✓ ArrayList (tốt split) + stateless ops + expensive per-element
List<Result> results = largeArrayList.parallelStream()   // 1M+ elements
    .filter(item -> item.isValid())                       // stateless
    .map(item -> expensiveComputation(item))              // CPU-heavy per element
    .collect(Collectors.toList());
```

### 10.2. Parallel chậm hơn ✗

```java
// ✗ LinkedList + sorted (barrier) + small data
linkedList.parallelStream()        // split = O(n), unbalanced
    .sorted()                      // barrier — phải buffer all
    .limit(10)                     // ordering constraint
    .collect(Collectors.toList());
```

### 10.3. Decision checklist

| Yếu tố | Parallel tốt | Parallel tệ |
|---------|-------------|-------------|
| Data source | ArrayList, array, IntStream.range | LinkedList, Stream.iterate |
| Operations | filter, map (stateless) | sorted, distinct (stateful) |
| Per-element cost | Cao (computation, I/O) | Thấp (simple getter) |
| Element count | > 10.000 | < 1.000 |
| Shared mutable state | Không | Có (synchronization) |
| Downstream collector | toList, groupingBy | toMap (merge conflict) |

> [!IMPORTANT]
> **Đo trước, parallel sau.** Đừng bao giờ thêm `.parallel()` vì "chắc sẽ nhanh hơn". JMH benchmark là cách duy nhất xác nhận. Parallel có overhead cố định — data nhỏ hoặc pipeline đơn giản → sequential nhanh hơn.

---

## 11. Stream vs Loop — performance so sánh thực tế

```text
JMH Benchmark (JDK 17, 1M integers, sum of squares of even numbers):

Benchmark                    Mode  Cnt    Score    Error  Units
forLoop                      avgt    5    2.31 ±  0.05   ms/op
streamSequential             avgt    5    2.45 ±  0.08   ms/op   (~6% slower)
streamParallel (8 cores)     avgt    5    0.41 ±  0.02   ms/op   (~5.6x faster)
```

**Sequential stream vs loop**: thường **~5-15% overhead** (auto-boxing, method call overhead, pipeline setup). JIT có thể close gap.

**Khi nào stream chậm hơn đáng kể?**
- **Primitive boxing**: `Stream<Integer>` vs `IntStream` — boxing/unboxing mỗi element
- **Small N**: pipeline setup overhead > computation
- **Heavy allocation**: `map()` tạo object mới mỗi element → GC pressure

```java
// ❌ Chậm: boxing Integer
int sum = list.stream()
    .map(x -> x * x)           // Integer → int → compute → Integer (boxing)
    .reduce(0, Integer::sum);

// ✅ Nhanh: primitive stream, no boxing
int sum = list.stream()
    .mapToInt(x -> x * x)      // int → int (no boxing)
    .sum();
```

---

## 12. Anti-patterns & production pitfalls

| Anti-pattern | Vì sao sai | Giải pháp |
|--------------|-----------|-----------|
| `parallelStream()` trên LinkedList | Split O(n), unbalanced | Dùng ArrayList hoặc sequential |
| Side-effect trong stream (modify shared state) | Race condition, unpredictable | `collect()` hoặc `reduce()` |
| `stream().forEach()` thay for-loop (no benefit) | Overhead, less readable | Plain for-loop |
| `.parallel()` cho < 1000 elements | Overhead > benefit | Sequential |
| `sorted()` rồi `findFirst()` | Sort toàn bộ chỉ để lấy min | `min(comparator)` |
| Stream reuse | `IllegalStateException` | Tạo stream mới mỗi lần |
| `peek()` cho business logic | Không đảm bảo chạy (lazy, short-circuit) | Dùng `map()` hoặc loop |
| `collect(toMap(...))` với duplicate key | `IllegalStateException` | Cung cấp merge function |

**Modify shared state trong stream:**

```java
// ❌ Race condition:
List<String> results = new ArrayList<>();  // shared mutable
list.parallelStream().forEach(item -> {
    results.add(process(item));            // concurrent add → ArrayIndexOutOfBounds
});

// ✅ Thread-safe collection:
List<String> results = list.parallelStream()
    .map(this::process)
    .collect(Collectors.toList());         // combiner merge safely
```

> [!WARNING]
> Stream API thiết kế cho **stateless, side-effect-free** operations. Hễ bạn thấy mình modify biến ngoài lambda → đang dùng sai tool. Dùng `collect`/`reduce` để accumulate results.

---

## 13. Tóm tắt — Cheat sheet & 5 nguyên tắc

**Cỗ máy trong 6 dòng:**

```
1. Stream = lazy pipeline: Source → Intermediate ops → Terminal op
2. Không gì chạy cho đến terminal op được gọi (lazy evaluation)
3. Loop fusion: mỗi element đi qua toàn bộ pipeline — không tạo collection trung gian
4. Parallel: Spliterator.trySplit() → ForkJoinPool → merge
5. Stateful ops (sorted, distinct) = barrier trong parallel — giảm benefit
6. N × Q phải đủ lớn để parallel bù overhead. Đo bằng JMH.
```

| Scenario | Dùng |
|----------|------|
| Transform collection → collection | `stream().map().collect()` |
| Filter + aggregate | `stream().filter().reduce()` |
| CPU-heavy trên large data | `parallelStream()` + ArrayList |
| Simple iteration, < 100 elements | Plain for-loop |
| Cần index hoặc break/continue | For-loop (stream không hỗ trợ) |

**5 nguyên tắc khắc cốt:**

1. **Lazy = miễn phí build pipeline** — chỉ tốn khi terminal chạy. Đừng sợ chain dài.
2. **Primitive stream** (`IntStream`, `LongStream`) — tránh boxing cho number-heavy code.
3. **Parallel ≠ magic** — đo bằng JMH, chỉ dùng khi N×Q lớn + source split tốt.
4. **Stateless > Stateful** — đặt `filter` trước `sorted` để giảm data qua barrier.
5. **Collect, don't mutate** — stream dành cho functional style. Side-effect = bug.

> [!TIP]
> Một câu để nhớ: *Stream nhanh vì lazy (không làm thừa) và fused (không allocate thừa). Parallel nhanh khi data lớn + source split đều + ops stateless. Violate bất kỳ điều kiện nào → chậm hơn for-loop.*
