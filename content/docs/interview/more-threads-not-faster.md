---
title: "Vì sao thêm nhiều thread mà app không nhanh hơn (thậm chí chậm đi)?"
description: "Câu hỏi phỏng vấn concurrency tách người học thuộc khỏi người hiểu hệ thống: tăng số thread từ 4 lên 100 mà throughput không tăng, có khi giảm. Mổ xẻ Amdahl's Law, CPU-bound vs I/O-bound, context switch, lock contention, false sharing, GC pressure, và cách chọn đúng kích thước thread pool."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)](#2-câu-trả-lời-30-giây-nếu-phỏng-vấn-hỏi-nhanh)
- [3. Hiểu lầm cốt lõi: "thêm thread = thêm tốc độ"](#3-hiểu-lầm-cốt-lõi-thêm-thread--thêm-tốc-độ)
- [4. Trần lý thuyết: Amdahl's Law](#4-trần-lý-thuyết-amdahls-law)
- [5. Câu hỏi đầu tiên phải hỏi: CPU-bound hay I/O-bound?](#5-câu-hỏi-đầu-tiên-phải-hỏi-cpu-bound-hay-io-bound)
- [6. Thủ phạm #1: Context switch — thread nhiều hơn core](#6-thủ-phạm-1-context-switch--thread-nhiều-hơn-core)
- [7. Thủ phạm #2: Lock contention — cổ chai vô hình](#7-thủ-phạm-2-lock-contention--cổ-chai-vô-hình)
- [8. Thủ phạm #3: False sharing — cache line bị giành](#8-thủ-phạm-3-false-sharing--cache-line-bị-giành)
- [9. Thủ phạm #4: GC pressure & bộ nhớ](#9-thủ-phạm-4-gc-pressure--bộ-nhớ)
- [10. Thủ phạm #5: Cổ chai tài nguyên dùng chung](#10-thủ-phạm-5-cổ-chai-tài-nguyên-dùng-chung)
- [11. Chọn đúng kích thước thread pool](#11-chọn-đúng-kích-thước-thread-pool)
- [12. Checklist chẩn đoán — vì sao không scale](#12-checklist-chẩn-đoán--vì-sao-không-scale)
- [13. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp](#13-câu-hỏi-đào-sâu-mà-người-phỏng-vấn-sẽ-hỏi-tiếp)
- [14. Tóm tắt — Cheat sheet & 3 nguyên tắc](#14-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi có một tác vụ xử lý dữ liệu. Chạy 1 thread mất 100 giây. Tôi nghĩ 'máy có 8 core, cho 8 thread sẽ nhanh gấp 8'. Nhưng thực tế chỉ nhanh gấp ~4. Tệ hơn, khi tôi tăng lên 100 thread với hy vọng nhanh nữa, throughput **không tăng** mà còn **giảm**. Tại sao thêm thread không giúp, thậm chí làm chậm đi?"*

Đây là câu hỏi tách biệt **người nghĩ song song = tuyến tính** với **người hiểu giới hạn vật lý của hệ thống**. Người mới tin "thread càng nhiều càng nhanh". Người hiểu sâu sẽ hỏi ngược lại ngay: **"Tác vụ này CPU-bound hay I/O-bound? Phần nào *thật sự* song song được, và phần dùng chung (lock, RAM, DB, đĩa) là gì?"**

> [!IMPORTANT]
> Mấu chốt: thread là công cụ để **tận dụng tài nguyên đang rảnh** (CPU core rảnh, hoặc thời gian chờ I/O), **không phải** phép nhân tốc độ. Khi tài nguyên đã bão hòa, hoặc khi có phần tuần tự dùng chung, thêm thread chỉ làm tăng **chi phí điều phối** (context switch, contention) mà không thêm việc thực. Đến một điểm, chi phí vượt lợi ích → chậm đi.

---

## 2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)

> Tốc độ không scale tuyến tính vì hai lý do gốc. **(1) Amdahl's Law**: mọi chương trình có phần *tuần tự* không song song được; phần đó đặt trần cho speedup dù bạn có bao nhiêu core. **(2) Tài nguyên hữu hạn**: số CPU core là cố định — quá số core, các thread phải tranh nhau CPU và tốn **context switch**; ngoài ra còn **lock contention** (thread chờ nhau ở vùng `synchronized`), **false sharing** (cache line bị invalidate qua lại), **GC pressure**, và **cổ chai dùng chung** (DB connection pool, đĩa, mạng).
>
> Số thread tối ưu phụ thuộc loại tác vụ: **CPU-bound** → khoảng bằng số core; **I/O-bound** → có thể nhiều hơn số core (vì thread chờ I/O thì nhường CPU), theo công thức `N_threads = N_core × (1 + thời_gian_chờ / thời_gian_tính)`. Cứ tăng thread vô tội vạ luôn phản tác dụng.

Phần còn lại của doc giải thích **từng thủ phạm** và **cách chọn số thread đúng** mà một câu trả lời sâu cần đề cập.

---

## 3. Hiểu lầm cốt lõi: "thêm thread = thêm tốc độ"

Mô hình sai trong đầu nhiều người:

```text
❌ Mô hình sai (tuyến tính vô hạn):
   1 thread  → 100s
   2 thread  → 50s
   4 thread  → 25s
   100 thread → 1s     ← "cứ chia đều ra là xong!"
```

Thực tế đường cong speedup luôn **cong và bão hòa**, rồi **đi xuống**:

```text
✅ Thực tế:
 speedup
   ▲
 5 │           ╭─────●──────●─────  ← bão hòa (Amdahl) rồi TỤT (overhead)
 4 │       ╭──●                 ●
 3 │     ╭●                        ●
 2 │   ╭●
 1 │ ●
   └──┴───┴───┴────┴──────────────────────► số thread
     1   2   4    8             100
        "vùng có lợi"   "vùng overhead lấn át"
```

Có hai lực kéo ngược nhau:
- **Lực có lợi**: nhiều thread → nhiều việc chạy song song trên nhiều core, hoặc lấp được thời gian chờ I/O.
- **Lực có hại** (tăng theo số thread): context switch, lock contention, false sharing, GC, tranh tài nguyên dùng chung.

Khi lực hại vượt lực lợi, đường cong đi xuống. Câu hỏi của phỏng vấn chính là: **"Bạn có biết các lực hại đó là gì không?"**

> [!NOTE]
> Một thread **không tự nó nhanh** — nó chỉ là một "luồng thực thi" cần một **CPU core** để chạy. Nếu bạn có 8 core mà tạo 100 thread, thì tại mỗi thời điểm tối đa **8 thread đang thật sự chạy**, 92 thread còn lại đang **xếp hàng chờ** — và việc luân phiên giữa chúng tốn chi phí.

---

## 4. Trần lý thuyết: Amdahl's Law

Đây là kiến thức nền mọi câu trả lời sâu phải nhắc tới. Amdahl's Law cho biết **giới hạn trên** của speedup khi một phần chương trình **không song song được**.

Gọi `P` = tỉ lệ phần *song song được*, `N` = số processor:

```text
              1
Speedup = ─────────────
          (1 − P) + P/N
```

Phần `(1 − P)` là **phần tuần tự** — dù `N → ∞`, speedup cũng không vượt `1 / (1 − P)`.

| Phần song song được (P) | Speedup tối đa (N → ∞) | Với N = 8 core |
|------------------------:|-----------------------:|---------------:|
| 50% | 2× | 1.78× |
| 75% | 4× | 2.91× |
| 90% | 10× | 4.71× |
| 95% | 20× | 5.93× |
| 99% | 100× | 7.48× |

Đọc bảng này: nếu chỉ **5%** code là tuần tự (P = 95%), thì dù có **vô hạn** core, bạn cũng chỉ nhanh được **20 lần**. Với 8 core thực tế chỉ ~5.9 lần. Đây giải thích trực tiếp vì sao "8 core mà chỉ nhanh 4 lần".

```text
Tác vụ 100s, giả sử 20s là tuần tự (đọc file đầu vào, gộp kết quả cuối):
   1 thread:  [████████ tuần tự 20s ████████ song song 80s ]  = 100s
   8 thread:  [████████ tuần tự 20s ██] song song 80/8=10s    = 30s
   → speedup = 100/30 ≈ 3.3×, KHÔNG phải 8×
   → phần tuần tự 20s là TRẦN không thể phá bằng cách thêm thread
```

> [!IMPORTANT]
> Bài học Amdahl: **muốn nhanh hơn, hãy giảm phần tuần tự, đừng chỉ thêm thread.** Nếu 20% là tuần tự, tối ưu phần đó xuống 5% còn giá trị hơn việc nhân đôi số core. Người phỏng vấn rất thích nghe ý này.

---

## 5. Câu hỏi đầu tiên phải hỏi: CPU-bound hay I/O-bound?

Trước khi nói số thread, phải phân loại tác vụ — vì câu trả lời ngược nhau hoàn toàn:

```text
CPU-BOUND (tính toán nặng: nén, mã hóa, xử lý ảnh, tính toán số):
   • Thread bận 100% trên CPU, không nghỉ
   • Quá số core → các thread chỉ tranh CPU + context switch
   • Số thread tối ưu ≈ số core (đôi khi core + 1)

I/O-BOUND (gọi API, query DB, đọc/ghi file, chờ mạng):
   • Thread phần lớn thời gian NGỒI CHỜ I/O, không dùng CPU
   • Trong lúc thread A chờ, core có thể chạy thread B → có lợi khi nhiều thread
   • Số thread tối ưu CÓ THỂ >> số core
```

Ví dụ trực quan với 8 core:

| Loại tác vụ | 8 thread | 100 thread | Lý do |
|-------------|----------|-----------|-------|
| CPU-bound (tính số nguyên tố) | Nhanh nhất | **Chậm hơn** | Chỉ 8 chạy được; 100 → context switch vô ích |
| I/O-bound (gọi 1000 API, mỗi cái chờ 200ms) | Chậm | **Nhanh hơn nhiều** | Lúc thread chờ mạng, thread khác tận dụng CPU |

> [!TIP]
> Nếu câu hỏi phỏng vấn nói "xử lý dữ liệu" mà không rõ, hãy **hỏi lại**: *"Tác vụ này phần lớn là tính toán trên CPU, hay là chờ I/O (DB/mạng/đĩa)?"* Hỏi đúng câu này cho thấy bạn tư duy theo bản chất, không học vẹt "số thread = số core".

---

## 6. Thủ phạm #1: Context switch — thread nhiều hơn core

CPU chỉ chạy được số thread bằng số core (logical core) tại một thời điểm. Khi có nhiều thread "sẵn sàng chạy" hơn số core, OS scheduler phải **luân phiên** chúng — gọi là **context switch**. Mỗi lần switch tốn:

```text
Một lần context switch phải:
   1. Lưu trạng thái thread đang chạy (thanh ghi, program counter, stack pointer)
   2. Nạp trạng thái thread kế tiếp
   3. (Ngầm) cache CPU bị "lạnh" — dữ liệu của thread cũ bị đẩy ra,
      thread mới phải nạp lại từ RAM → cache miss tăng vọt
   → Chi phí trực tiếp ~1-5 µs; chi phí gián tiếp (cache lạnh) còn lớn hơn
```

Với CPU-bound, hậu quả rất rõ: 8 core mà chạy 100 thread → mỗi thread chỉ được một "lát" CPU rồi bị đẩy ra, làm việc dở dang, cache vừa nóng đã bị đá đi. Tổng công việc **không đổi** nhưng **chi phí điều phối tăng tuyến tính theo số thread** → throughput giảm.

> [!WARNING]
> "Thrashing": khi số thread quá lớn, CPU dành phần lớn thời gian để *chuyển ngữ cảnh* thay vì *làm việc thật*. Đây là lý do tạo 10,000 thread platform (mỗi thread ~1MB stack) không những chậm mà còn có thể `OutOfMemoryError: unable to create native thread`.

---

## 7. Thủ phạm #2: Lock contention — cổ chai vô hình

Đây là thủ phạm hay bị bỏ sót nhất. Nếu các thread cùng tranh một `synchronized` block (hoặc một lock), thì đoạn đó **thực chất chạy tuần tự** — thêm thread chỉ tạo thêm hàng đợi chờ lock.

```java
// ❌ Bottleneck ẩn: mọi thread tranh nhau MỘT lock
class Counter {
    private long count = 0;
    public synchronized void increment() {   // ← chỉ 1 thread vào được mỗi lúc
        count++;
    }
}
// 100 thread cùng gọi increment() → 99 thread XẾP HÀNG chờ → tuần tự hóa
```

```text
Hiệu ứng lên Amdahl: vùng synchronized = phần TUẦN TỰ.
   Lock giữ càng lâu / tranh càng nhiều → (1−P) càng lớn → trần speedup càng thấp.
   Thêm thread vào vùng tranh lock = thêm người xếp hàng, KHÔNG thêm thông lượng.
```

Cách giảm contention:

| Kỹ thuật | Ý tưởng |
|----------|---------|
| Thu nhỏ vùng khóa | Chỉ `synchronized` đúng dòng cần, không bọc cả method |
| Lock striping | Chia dữ liệu thành nhiều phần, mỗi phần một lock (vd `ConcurrentHashMap`) |
| Cấu trúc lock-free | `AtomicLong`, `LongAdder` (LongAdder chia nhỏ để giảm tranh) |
| Bất biến / thread-local | Không chia sẻ state → không cần lock |
| `ReadWriteLock` | Nhiều reader song song, chỉ writer độc quyền |

> [!TIP]
> `LongAdder` thay `AtomicLong` là ví dụ kinh điển: dưới tải cao nhiều thread, `AtomicLong.incrementAndGet()` bị tranh CAS dữ dội; `LongAdder` giữ nhiều ô đếm (cell) riêng để các thread cộng vào ô khác nhau, chỉ gộp khi đọc → scale tốt hơn hẳn khi ghi nhiều.

---

## 8. Thủ phạm #3: False sharing — cache line bị giành

Đây là chi tiết "ăn điểm" cao trong phỏng vấn. Đôi khi các thread **không** chia sẻ biến nào, **không** dùng lock chung, vậy mà vẫn chậm khi thêm thread. Thủ phạm: **false sharing**.

CPU không quản lý bộ nhớ theo từng byte mà theo **cache line** (thường 64 byte). Nếu hai biến độc lập **nằm cùng một cache line**, và hai thread (trên hai core) mỗi thread ghi một biến, thì mỗi lần ghi làm **invalidate toàn bộ cache line** ở core kia — dù chúng chẳng dùng chung dữ liệu gì.

```text
Cache line 64 byte:  [ counter[0] | counter[1] | ... ]
   Core 0 ghi counter[0] → invalidate cache line ở Core 1
   Core 1 ghi counter[1] → invalidate cache line ở Core 0
   → "ping-pong" cache line qua lại liên tục giữa các core
   → cực chậm, dù hai biến HOÀN TOÀN độc lập
```

```java
// ❌ Dễ dính false sharing: mỗi thread ghi 1 phần tử kề nhau
long[] counters = new long[numThreads];
// thread i chỉ làm counters[i]++ — tưởng độc lập, nhưng các phần tử nằm chung cache line

// ✅ Cách tránh: padding, hoặc @Contended (JDK), hoặc dùng LongAdder/cấu trúc sẵn có
```

> [!NOTE]
> Java có annotation `@jdk.internal.vm.annotation.Contended` (và trước đây các thư viện tự "pad" 7 biến long thừa) để đẩy mỗi biến nóng sang cache line riêng. Nhắc tới false sharing + cache line 64 byte trong phỏng vấn cho thấy bạn hiểu xuống tới tầng phần cứng.

---

## 9. Thủ phạm #4: GC pressure & bộ nhớ

Thêm thread thường đồng nghĩa **tạo thêm object** đồng thời (mỗi request/task cấp phát buffer, DTO...). Điều này dồn áp lực lên Garbage Collector:

```text
Nhiều thread → tốc độ cấp phát (allocation rate) tăng
   → Young generation đầy nhanh hơn → GC chạy thường xuyên hơn
   → GC pause (stop-the-world) "ăn" vào thời gian của TẤT CẢ thread
   → Đến mức nào đó: app dành nhiều thời gian GC hơn làm việc
```

Ngoài ra mỗi platform thread tốn **~512KB–1MB stack**. 1000 thread ≈ 0.5–1GB chỉ riêng cho stack — chưa kể heap. Đây là một lý do nữa khiến "spam thread" phản tác dụng, và là động lực cho **virtual threads** (Project Loom) — thread siêu nhẹ cho tác vụ I/O-bound.

> [!TIP]
> Nếu app I/O-bound cần hàng nghìn luồng đồng thời, **virtual threads** (JDK 21+) là lời giải hiện đại: chúng rất rẻ (không chiếm OS thread khi đang chờ I/O), cho phép viết code blocking đơn giản mà vẫn scale tới hàng triệu luồng. Nhưng với **CPU-bound** thì virtual threads **không** giúp — giới hạn vẫn là số core.

---

## 10. Thủ phạm #5: Cổ chai tài nguyên dùng chung

Thread của bạn có thể scale, nhưng **tài nguyên phía sau** thì không. Đây là nguyên nhân phổ biến nhất trong app thực tế (web service):

| Tài nguyên dùng chung | Vì sao thành cổ chai |
|-----------------------|----------------------|
| **DB connection pool** | Pool chỉ có vd 10 connection; 100 thread → 90 thread chờ connection |
| **Database** | DB có giới hạn IOPS/CPU; 100 query song song có thể làm DB nghẽn, lock row |
| **Đĩa** | Băng thông I/O đĩa hữu hạn; nhiều thread đọc/ghi → tranh nhau, random I/O |
| **Network/băng thông** | Tổng băng thông cố định; chia cho nhiều thread không tăng tổng |
| **API bên thứ ba** | Rate limit; quá nhiều request song song → bị 429 / throttle |

```text
App server (100 thread)  ──►  DB connection pool (10 conn)  ──►  Database
                              ▲
                         CỔ CHAI THẬT nằm ở đây, không phải số thread
   → Tăng thread từ 100 lên 200 không giúp gì: vẫn chỉ 10 query chạy được cùng lúc
```

> [!WARNING]
> Sai lầm kinh điển: thấy app chậm bèn tăng thread pool từ 100 lên 500, khiến DB connection pool cạn kiệt và DB quá tải → **chậm hơn nữa**, thậm chí sập. Phải tìm **cổ chai thật** (thường là DB/đĩa/mạng), không phải cứ tăng thread.

---

## 11. Chọn đúng kích thước thread pool

Công thức thực dụng (theo Brian Goetz — *Java Concurrency in Practice*):

```text
N_threads = N_core × U × (1 + W/C)

  N_core = số CPU core (Runtime.getRuntime().availableProcessors())
  U      = target CPU utilization mong muốn (0..1, vd 0.8)
  W/C    = tỉ lệ (thời gian CHỜ) / (thời gian TÍNH) của một tác vụ
```

```text
CPU-BOUND (W/C ≈ 0):
   N_threads ≈ N_core × U × (1 + 0) ≈ N_core
   → ví dụ 8 core → ~8 thread (đôi khi N_core + 1 để lấp lúc thread bị page fault)

I/O-BOUND (chờ nhiều, vd chờ 90ms, tính 10ms → W/C = 9):
   N_threads ≈ N_core × (1 + 9) = N_core × 10
   → ví dụ 8 core → ~80 thread (vì mỗi thread chỉ dùng CPU 10% thời gian)
```

Nguyên tắc thực hành:

| Loại | Pool gợi ý |
|------|------------|
| CPU-bound | `Runtime.getRuntime().availableProcessors()` (hoặc +1) |
| I/O-bound (truyền thống) | Đo `W/C` rồi áp công thức; thường vài chục–vài trăm, **giới hạn bởi cổ chai phía sau** (DB pool!) |
| I/O-bound (JDK 21+) | Cân nhắc **virtual threads** thay vì pool lớn |
| Hỗn hợp | Tách thành nhiều pool riêng cho từng loại, tránh tác vụ chậm chiếm hết pool |

> [!IMPORTANT]
> Đừng dùng `Executors.newCachedThreadPool()` cho tải lớn không kiểm soát — nó tạo thread không giới hạn và có thể làm sập máy. Dùng `ThreadPoolExecutor` với số thread và **bounded queue** rõ ràng, cộng chính sách từ chối (rejection policy) hợp lý. Và luôn nhớ: số thread tối ưu phải **đo bằng benchmark trên môi trường thật**, công thức chỉ là điểm khởi đầu.

---

## 12. Checklist chẩn đoán — vì sao không scale

```text
╭──────────────────────────────────────────────────────────────╮
│ B1. Tác vụ CPU-bound hay I/O-bound?                          │
│     • CPU-bound → số thread tối ưu ≈ số core. Quá đó = hại.   │
│     • I/O-bound → cần nhiều thread hơn, nhưng coi chừng cổ chai│
│                                                              │
│ B2. Đo CPU utilization khi chạy nhiều thread:                │
│     • CPU ~100% mà không nhanh hơn → context switch/Amdahl   │
│     • CPU thấp mà vẫn chậm → đang CHỜ (lock? I/O? DB pool?)   │
│                                                              │
│ B3. Có vùng synchronized/lock nóng không?                    │
│     • Có → lock contention (mục 7). Profile thời gian chờ lock│
│                                                              │
│ B4. Có tài nguyên dùng chung giới hạn không?                 │
│     • DB connection pool / đĩa / mạng / rate limit (mục 10)   │
│                                                              │
│ B5. GC chiếm bao nhiêu %? Có OOM/thread creation fail không? │
│     • GC cao hoặc tạo thread thất bại → quá nhiều thread (m9) │
│                                                              │
│ B6. Nghi false sharing? (CPU cao, không lock, vẫn chậm)      │
│     • Kiểm tra biến nóng nằm chung cache line (mục 8)         │
╰──────────────────────────────────────────────────────────────╯
```

> [!TIP]
> Quy tắc loại trừ vàng: **nhìn CPU utilization trước.** CPU đã ~100% mà không nhanh hơn → bạn đã bão hòa core (Amdahl/context switch), thêm thread vô ích. CPU còn thấp mà vẫn chậm → thread đang **chờ** thứ gì đó (lock, I/O, DB connection) → tìm cái nó chờ, đừng thêm thread.

---

## 13. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp

> **"8 core sao chỉ nhanh 4 lần?"**
Amdahl's Law: có phần tuần tự (đọc input, gộp kết quả, vùng synchronized) không song song được; cộng với context switch, contention, và cache effect. Speedup tuyến tính hoàn hảo gần như không tồn tại trong thực tế.

> **"Vậy cứ I/O-bound thì tạo càng nhiều thread càng tốt?"**
Không. Vẫn bị chặn bởi **cổ chai phía sau** (DB connection pool, rate limit của API, băng thông). Và mỗi platform thread tốn ~1MB stack → quá nhiều sẽ OOM. Đây là lúc cân nhắc virtual threads hoặc mô hình async/reactive.

> **"Virtual threads (Loom) có làm CPU-bound nhanh hơn không?"**
Không. Virtual threads giải quyết vấn đề **số lượng luồng chờ I/O**, không tăng số core. CPU-bound vẫn bị giới hạn bởi số core vật lý — virtual threads thậm chí không có lợi gì ở đây.

> **"Làm sao biết app đang CPU-bound hay I/O-bound?"**
Đo CPU utilization khi chạy. CPU sát 100% → CPU-bound. CPU thấp mà vẫn chậm → đang chờ I/O. Dùng profiler (async-profiler, JFR) xem thời gian nằm ở `RUNNABLE` (tính) hay `WAITING`/`BLOCKED` (chờ).

> **"`LongAdder` khác `AtomicLong` ở điểm scale thế nào?"**
`AtomicLong` dùng một biến + CAS; tải cao nhiều thread → CAS thất bại và retry liên tục (tranh chấp). `LongAdder` giữ nhiều cell, mỗi thread cộng vào cell khác nhau (giảm tranh), chỉ gộp khi `sum()`. Khi ghi nhiều, đọc ít → `LongAdder` scale tốt hơn hẳn.

> **"Amdahl và Gustafson khác nhau gì?"**
Amdahl giả định **kích thước bài toán cố định** → trần speedup. Gustafson lập luận rằng trong thực tế khi có nhiều core, ta thường **tăng kích thước bài toán** (xử lý nhiều dữ liệu hơn) → speedup khả dụng (scaled speedup) lạc quan hơn. Nhắc cả hai cho thấy bạn hiểu sắc thái.

---

## 14. Tóm tắt — Cheat sheet & 3 nguyên tắc

**Cheat sheet — vì sao thêm thread không nhanh hơn:**

| Triệu chứng | Thủ phạm | Hướng xử lý |
|-------------|----------|-------------|
| CPU ~100%, không nhanh thêm | Bão hòa core + context switch (CPU-bound) | Giảm thread về ~số core |
| CPU thấp, vẫn chậm | Đang chờ: lock / I/O / DB pool | Tìm cái nó chờ, không thêm thread |
| Chậm dần khi tăng thread | Lock contention (vùng synchronized nóng) | Thu nhỏ lock, lock striping, lock-free |
| CPU cao, không lock, vẫn chậm | False sharing (cache line bị ping-pong) | Padding / `@Contended` / `LongAdder` |
| GC cao / OOM thread | Quá nhiều thread, allocation cao | Giảm thread, virtual threads, giảm rác |
| Tăng thread mà DB nghẽn | Cổ chai DB connection pool / DB | Sửa cổ chai thật, không tăng thread |

**Ba nguyên tắc để chọn thread đúng:**

1. **Phân loại trước: CPU-bound (≈ số core) hay I/O-bound (nhiều hơn, theo W/C).** Sai loại = sai mọi quyết định sau đó.
2. **Speedup bị chặn bởi phần tuần tự (Amdahl) và cổ chai dùng chung.** Muốn nhanh hơn → giảm phần tuần tự / mở rộng cổ chai, không chỉ thêm thread.
3. **Thread là chi phí, không phải phép màu.** Mỗi thread tốn stack + context switch + có thể gây contention/false sharing. Số tối ưu phải **đo bằng benchmark**, không đoán.

> [!IMPORTANT]
> Câu trả lời ghi điểm trọn vẹn gồm: **(1)** hỏi ngay CPU-bound hay I/O-bound; **(2)** nêu Amdahl's Law là trần lý thuyết; **(3)** liệt kê các overhead thật — context switch, lock contention, false sharing, GC, cổ chai tài nguyên; **(4)** đưa công thức chọn thread pool và nhấn mạnh phải **đo**, không spam thread.
