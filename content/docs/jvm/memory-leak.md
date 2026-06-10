---
title: "Memory Leak — Deep Dive"
description: "Mổ xẻ Memory Leak trong Java: tại sao có GC vẫn leak, GC Roots & reachability chain, Reference types (Strong/Soft/Weak/Phantom), ReferenceQueue, 10 nguyên nhân leak phổ biến (static collection, inner class, ThreadLocal, ClassLoader, unclosed resources, listener, cache), heap dump analysis (MAT, jmap, jcmd), production troubleshooting, và anti-patterns."
---

## Mục lục

- [Bối cảnh: OOM sau 3 ngày — GC chạy liên tục nhưng không cứu được](#1-bối-cảnh-oom-sau-3-ngày--gc-chạy-liên-tục-nhưng-không-cứu-được)
- [Memory Leak trong Java — GC không phải thuốc chữa bách bệnh](#2-memory-leak-trong-java--gc-không-phải-thuốc-chữa-bách-bệnh)
- [GC Roots & Reachability — ai quyết định object sống hay chết](#3-gc-roots--reachability--ai-quyết-định-object-sống-hay-chết)
- [Reference Types — Strong, Soft, Weak, Phantom](#4-reference-types--strong-soft-weak-phantom)
- [10 nguyên nhân Memory Leak phổ biến](#5-10-nguyên-nhân-memory-leak-phổ-biến)
- [ThreadLocal Leak — bẫy đặc biệt nguy hiểm](#6-threadlocal-leak--bẫy-đặc-biệt-nguy-hiểm)
- [ClassLoader Leak — Metaspace OOM](#7-classloader-leak--metaspace-oom)
- [Heap Dump — capture và phân tích](#8-heap-dump--capture-và-phân-tích)
- [MAT (Memory Analyzer Tool) — đọc heap dump](#9-mat-memory-analyzer-tool--đọc-heap-dump)
- [Production Monitoring — phát hiện leak sớm](#10-production-monitoring--phát-hiện-leak-sớm)
- [Anti-patterns & Tóm tắt](#11-anti-patterns--tóm-tắt)

---

## 1. Bối cảnh: OOM sau 3 ngày — GC chạy liên tục nhưng không cứu được

Service xử lý event từ Kafka. Mỗi event được log vào cache "gần đây" để debug:

```java
public class EventProcessor {
    private static final Map<String, Event> recentEvents = new HashMap<>();

    public void process(Event event) {
        recentEvents.put(event.getId(), event);  // cache để tra cứu debug
        doBusinessLogic(event);
    }
}
```

Trên dev (vài nghìn event): OK. Production (triệu event/ngày): heap tăng đều, GC chạy ngày càng nhiều:

```
Day 1:  Heap usage 40% → GC ~5%  time
Day 2:  Heap usage 70% → GC ~20% time
Day 3:  Heap usage 95% → GC ~80% time → Full GC liên tục
        java.lang.OutOfMemoryError: Java heap space
```

GC Log:
```
[Full GC (Ergonomics) 3891M->3889M(4096M), 8.234 secs]   ← thu hồi 2 MB / 3.8 GB
[Full GC (Ergonomics) 3891M->3890M(4096M), 8.456 secs]   ← GC gần như vô dụng
```

GC chạy liên tục nhưng **thu hồi gần như không gì** — vì `recentEvents` là `static` HashMap, giữ **strong reference** tới mọi event từ ngày 1. GC **không thể** thu hồi object mà vẫn reachable.

> [!IMPORTANT]
> Memory leak trong Java **không phải** "quên free memory" (như C/C++). Nó là **object vẫn reachable qua reference chain nhưng ứng dụng không bao giờ dùng nữa**. GC thấy object reachable → không thu hồi → heap đầy dần.

---

## 2. Memory Leak trong Java — GC không phải thuốc chữa bách bệnh

| Ngôn ngữ | Leak vì | Triệu chứng |
|----------|---------|-------------|
| C/C++ | Quên `free()` / `delete` | Dùng bao nhiêu leak bấy nhiêu |
| Java | Object reachable nhưng không dùng | Heap tăng dần, GC tốn thời gian tăng, cuối cùng OOM |

Định nghĩa trong Java: **Memory leak = object mà ứng dụng không còn cần nhưng GC không thu hồi được vì vẫn có reference chain tới GC Root.**

```
GC Root → ... → Container (HashMap) → Entry → Event object
                                              ↑
                                    Ứng dụng không cần nữa, nhưng reference vẫn còn
```

---

## 3. GC Roots & Reachability — ai quyết định object sống hay chết

GC bắt đầu từ **GC Roots** và duyệt theo reference chain. Object **reachable** từ root → sống. Object **unreachable** → chết → thu hồi.

### 3.1. GC Roots trong Java

| GC Root | Ví dụ |
|---------|-------|
| **Local variables** trên stack | Biến trong method đang chạy |
| **Static fields** | `private static final Map<> cache` |
| **Active threads** | Thread đang sống + ThreadLocal entries |
| **JNI references** | Native code giữ reference |
| **Synchronized monitors** | Object đang bị lock |
| **System ClassLoader** | Classes loaded bởi bootstrap/system classloader |

### 3.2. Reachability chain — đường đi từ Root tới Leak

```
GC Root: Static field EventProcessor.recentEvents
    └─ HashMap table[]
        └─ Node
            └─ key: "evt-1234" (String)
            └─ value: Event object (1 KB)
                └─ payload: byte[] (100 KB)  ← leak!
```

> [!NOTE]
> Leak thường không phải 1 object lớn mà là **hàng triệu object nhỏ** tích tụ qua thời gian. Biểu đồ heap điển hình: **đường chéo đi lên** — mỗi GC cycle thu hồi ít hơn lần trước, baseline tăng dần.

---

## 4. Reference Types — Strong, Soft, Weak, Phantom

Java cung cấp 4 mức "sức mạnh" reference để kiểm soát GC:

| Type | Class | GC thu hồi khi | Use case |
|------|-------|----------------|----------|
| **Strong** | (default) | **Không** — chừng nào còn reachable | Mọi biến thông thường |
| **Soft** | `SoftReference<T>` | Khi **sắp OOM** (GC cố gắng giữ nếu có đủ memory) | Cache (GC tự evict khi cần) |
| **Weak** | `WeakReference<T>` | Ở **lần GC kế tiếp** (nếu không có strong ref khác) | `WeakHashMap`, canonicalize map |
| **Phantom** | `PhantomReference<T>` | Sau khi object đã finalize, trước khi memory thật sự thu hồi | Resource cleanup (thay thế `finalize()`) |

### 4.1. WeakHashMap — cache tự dọn

```java
Map<Key, Value> cache = new WeakHashMap<>();
// Khi Key không còn strong reference từ nơi nào → entry tự biến mất sau GC
```

### 4.2. SoftReference cache

```java
Map<String, SoftReference<Bitmap>> imageCache = new HashMap<>();

public Bitmap getImage(String url) {
    SoftReference<Bitmap> ref = imageCache.get(url);
    Bitmap bmp = (ref != null) ? ref.get() : null;
    if (bmp == null) {
        bmp = loadFromDisk(url);
        imageCache.put(url, new SoftReference<>(bmp));
    }
    return bmp;
}
```

> [!TIP]
> `SoftReference` cho phép GC tự evict cache entry khi heap gần đầy — "best-effort cache" không cần LRU logic. Nhưng **không thể kiểm soát chính xác** entry nào bị evict → dùng cho cache thứ yếu, không phải primary storage.

### 4.3. ReferenceQueue — nhận thông báo khi object bị GC

```java
ReferenceQueue<Object> queue = new ReferenceQueue<>();
WeakReference<Object> ref = new WeakReference<>(new Object(), queue);

// Sau GC:
Reference<?> collected = queue.poll();  // ref xuất hiện ở đây khi object bị GC
if (collected != null) {
    // cleanup resources liên quan tới object đã chết
}
```

`PhantomReference` **bắt buộc** dùng với ReferenceQueue — đây là cách thay thế `finalize()` (deprecated Java 9+) cho resource cleanup.

---

## 5. 10 nguyên nhân Memory Leak phổ biến

| # | Nguyên nhân | Pattern | Fix |
|---|------------|---------|-----|
| 1 | **Static collection không bound** | `static Map` chỉ `put`, không `remove` | Bounded cache (Caffeine, LRU), `WeakHashMap` |
| 2 | **Unclosed resources** | `InputStream`, `Connection`, `ResultSet` không close | `try-with-resources` |
| 3 | **Listener/callback không deregister** | `addListener()` mà không `removeListener()` | `WeakReference` listener, hoặc deregister ở lifecycle |
| 4 | **Inner class giữ outer reference** | Non-static inner class giữ implicit `this` | Dùng **static** inner class |
| 5 | **ThreadLocal không remove** | Thread pool reuse thread → ThreadLocal sống mãi | `try { ... } finally { threadLocal.remove(); }` |
| 6 | **String.intern() quá nhiều** | Intern string động → string pool phình | Không intern string từ user input |
| 7 | **ClassLoader leak** | Hot deploy tạo ClassLoader mới nhưng class cũ không unload | Restart JVM, Xử lý thread/static reference |
| 8 | **Autoboxing trong collection** | `Map<Integer, Integer>` → mỗi entry tạo Integer object | Primitive map (Eclipse Collections, HPPC) |
| 9 | **StringBuilder / byte[] tạm không giới hạn** | Buffer tăng dần, không shrink | Set max capacity, pool buffer |
| 10 | **Custom equals/hashCode sai** | Object "mất" trong HashSet/HashMap (mục 11 hashmap-deep-dive) | Immutable key, đúng contract |

---

## 6. ThreadLocal Leak — bẫy đặc biệt nguy hiểm

### 6.1. Cơ chế ThreadLocal

Mỗi Thread có một `ThreadLocalMap` riêng (field `threadLocals`). Key là `WeakReference<ThreadLocal>`, value là **strong reference**:

```
Thread object
  └─ threadLocals: ThreadLocalMap
       └─ Entry[] table
            └─ Entry (extends WeakReference<ThreadLocal<?>>)
                 ├─ key: WeakReference → ThreadLocal instance
                 └─ value: Object ← STRONG reference!
```

### 6.2. Tại sao leak?

Trong **thread pool**, thread **không chết** → ThreadLocalMap **sống mãi**:

```java
private static final ThreadLocal<byte[]> BUFFER = ThreadLocal.withInitial(() -> new byte[1024 * 1024]);

void handleRequest() {
    byte[] buf = BUFFER.get();     // 1 MB buffer per thread
    // ... dùng buf ...
    // QUÊN BUFFER.remove()
}
// Thread pool reuse thread → buffer 1 MB SỐNG MÃI cho mỗi thread
// 200 pool threads × 1 MB = 200 MB leak tĩnh
```

Khi `ThreadLocal` biến không còn strong reference (static field bị unload — hiếm, nhưng xảy ra với hot deploy):
- Key (WeakReference) bị GC → key = null
- Value (strong reference) **vẫn còn** → GC không thu hồi → **stale entry leak**

### 6.3. Fix

```java
void handleRequest() {
    try {
        byte[] buf = BUFFER.get();
        // dùng buf
    } finally {
        BUFFER.remove();              // BẮT BUỘC trong thread pool
    }
}
```

> [!WARNING]
> **Luôn** gọi `ThreadLocal.remove()` trong `finally` khi dùng thread pool. Đây là nguyên nhân leak phổ biến nhất trong Spring (request-scoped ThreadLocal + Tomcat thread pool) và Netty.

---

## 7. ClassLoader Leak — Metaspace OOM

### 7.1. Cơ chế

Khi ứng dụng hot-deploy (JEE container, Tomcat, OSGi): ClassLoader cũ tạo mới → load class mới. Class cũ **chỉ** được unload khi **ClassLoader** bị GC. ClassLoader bị GC **chỉ khi**:
- Không còn strong reference tới ClassLoader
- Không còn strong reference tới bất kỳ Class nào nó load
- Không còn instance nào của class đó sống

Nếu **bất kỳ** tham chiếu nào còn sống (ThreadLocal, static field, timer, listener...) → cả ClassLoader + tất cả class + tất cả static → **sống mãi**.

```
Metaspace:
  Redeploy 1: ClassLoader₁ + 500 classes (10 MB)    ← không thể GC
  Redeploy 2: ClassLoader₂ + 500 classes (10 MB)    ← không thể GC
  Redeploy 3: ClassLoader₃ + 500 classes (10 MB)
  ...
  → Metaspace OOM: java.lang.OutOfMemoryError: Metaspace
```

### 7.2. Nguyên nhân thường gặp

| Nguyên nhân | Ví dụ |
|------------|-------|
| ThreadLocal không remove | Thread pool thread giữ class từ ClassLoader cũ |
| JDBC Driver register | `DriverManager` giữ reference tới Driver class |
| Logging framework | Static logger giữ reference tới ClassLoader |
| Shutdown hook | `Runtime.addShutdownHook()` giữ thread/class |

> [!NOTE]
> ClassLoader leak **không** gây OOM heap mà gây **OOM Metaspace** (hoặc PermGen trước Java 8). Fix: deregister mọi thứ trước undeploy, hoặc đơn giản — **restart JVM** (ưu tiên trong container/Kubernetes).

---

## 8. Heap Dump — capture và phân tích

### 8.1. Capture heap dump

```bash
# Cách 1: jmap (JDK tool)
jmap -dump:format=b,file=heap.hprof <pid>

# Cách 2: jcmd (khuyên dùng)
jcmd <pid> GC.heap_dump /tmp/heap.hprof

# Cách 3: JVM flag — tự động dump khi OOM
java -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/var/dumps/ \
     -jar app.jar

# Cách 4: JMX (programmatic)
HotSpotDiagnosticMXBean bean = ManagementFactory.getPlatformMXBean(
    HotSpotDiagnosticMXBean.class);
bean.dumpHeap("/tmp/heap.hprof", true);
```

> [!IMPORTANT]
> **Luôn** bật `-XX:+HeapDumpOnOutOfMemoryError` trên production. Khi OOM xảy ra lúc 3 giờ sáng, heap dump là bằng chứng duy nhất. Không có nó = mất cơ hội debug.

### 8.2. Lưu ý khi dump

- Heap dump **đóng băng** JVM trong lúc dump (STW) — với heap 8 GB có thể mất **10-30 giây**
- File dump = kích thước heap → cần đủ disk space
- Compress: `gzip heap.hprof` trước khi download

---

## 9. MAT (Memory Analyzer Tool) — đọc heap dump

### 9.1. Key concepts trong MAT

| Concept | Ý nghĩa |
|---------|---------|
| **Shallow Size** | Bộ nhớ object tự nó chiếm (header + fields) |
| **Retained Size** | Bộ nhớ sẽ được giải phóng nếu GC object này (gồm cả object nó giữ exclusive) |
| **Dominator Tree** | Cây showing object nào "dominate" (giữ sống) object nào |
| **GC Root Path** | Đường từ GC Root → leak object — **quan trọng nhất để tìm leak** |
| **Histogram** | Số lượng và memory theo class — tìm class nào chiếm nhiều nhất |

### 9.2. Workflow tìm leak

```
1. Mở heap dump trong MAT
2. "Leak Suspects Report" → MAT tự phân tích, chỉ ra suspect
3. Histogram → sort by Retained Size → class nào lớn nhất?
4. Dominator Tree → object nào giữ sống nhiều memory nhất?
5. Right-click → "Path to GC Roots" → exclude weak/soft references
6. Tìm được chain: Static field → Collection → Leak objects
7. Fix code: remove entry, bound collection, hoặc dùng weak reference
```

### 9.3. OQL (Object Query Language)

```sql
-- Tìm tất cả HashMap với hơn 10000 entry
SELECT * FROM java.util.HashMap WHERE size > 10000

-- Tìm byte[] lớn hơn 1 MB
SELECT * FROM byte[] WHERE @retainedHeapSize > 1048576

-- Tìm ThreadLocal entries
SELECT * FROM java.lang.ThreadLocal$ThreadLocalMap$Entry
```

> [!TIP]
> Ngoài MAT (Eclipse), có thể dùng **VisualVM**, **YourKit**, **JProfiler**, hoặc `jhat` (deprecated). MAT là miễn phí và mạnh nhất cho phân tích leak.

---

## 10. Production Monitoring — phát hiện leak sớm

### 10.1. GC Log — indicator đầu tiên

```bash
java -Xlog:gc*:file=gc.log:time,uptime,level,tags \
     -XX:+HeapDumpOnOutOfMemoryError \
     -jar app.jar
```

**Dấu hiệu leak trong GC log**:
- Full GC ngày càng thường xuyên
- Heap **sau** GC (baseline) **tăng dần** qua thời gian
- GC **thu hồi ngày càng ít** memory mỗi lần

### 10.2. Metrics cần monitor

| Metric | Tool | Alert khi |
|--------|------|----------|
| Heap used after GC | Micrometer + Prometheus | Tăng đều > 80% qua 1 giờ |
| GC pause time | JMX GarbageCollectorMXBean | Pause > 500ms |
| GC overhead | `-XX:+UseGCOverheadLimit` | GC chiếm > 98% time |
| Metaspace used | MemoryPoolMXBean | Tăng liên tục (ClassLoader leak) |
| Thread count | ThreadMXBean | Tăng không giảm (thread leak) |

### 10.3. Live memory profiling (nếu cần)

```bash
# Flight Recorder — low overhead (~2%), production-safe
jcmd <pid> JFR.start name=leak duration=60s filename=/tmp/recording.jfr

# Async-profiler — allocation profiling
./asprof -e alloc -d 30 -f alloc.html <pid>
```

> [!NOTE]
> JFR (Java Flight Recorder) là lựa chọn tốt nhất cho production profiling — overhead rất thấp (~1-2%), ghi lại allocation, GC, lock contention, I/O. Miễn phí từ JDK 11+.

---

## 11. Anti-patterns & Tóm tắt

### Anti-patterns

| Anti-pattern | Vì sao sai | Sửa |
|--------------|-----------|-----|
| `static Map` chỉ put không remove | Collection lớn mãi | Bounded cache (Caffeine), WeakHashMap |
| Không close resource trong finally | File handle / connection leak | try-with-resources |
| ThreadLocal không remove trong thread pool | Value sống mãi per thread | `finally { tl.remove(); }` |
| Non-static inner class giữ outer `this` | Outer object không thể GC | Static inner class + explicit reference |
| Không bật HeapDumpOnOutOfMemoryError | Mất cơ hội debug OOM production | Luôn bật flag này |
| addListener mà không removeListener | Listener object sống mãi | Deregister lifecycle, WeakReference listener |
| Hot deploy không cleanup | ClassLoader leak → Metaspace OOM | Deregister drivers, shutdown hooks, ThreadLocal; hoặc restart JVM |

### Tóm tắt — Cheat sheet

```
Memory Leak trong Java = Object reachable nhưng không cần → GC không thu hồi

1. GC Roots: static field, local variable, active thread, JNI, monitor
2. Leak = path từ GC Root → object không cần nữa vẫn tồn tại
3. Reference types: Strong > Soft > Weak > Phantom
4. Top causes: static collection, ThreadLocal, unclosed resource, listener, ClassLoader
5. Detect: GC log (baseline tăng), heap dump + MAT
6. -XX:+HeapDumpOnOutOfMemoryError là BẮT BUỘC trên production
```

| Tình huống | Giải pháp |
|-----------|-----------|
| Cache tự dọn khi cần memory | `SoftReference` / Caffeine |
| Map key tự GC | `WeakHashMap` |
| ThreadLocal trong thread pool | `finally { remove(); }` |
| Resource (IO, DB) | try-with-resources |
| Tìm leak object | Heap dump + MAT Dominator Tree + GC Root Path |
| Production monitoring | GC log + Micrometer + JFR |

> [!TIP]
> Một câu để nhớ: *GC thu hồi object unreachable — memory leak là giữ reference tới object bạn không cần nữa.* Phòng tránh bằng bounded collection, try-with-resources, ThreadLocal.remove(), và luôn nghĩ "ai sẽ remove entry này khỏi collection?".
