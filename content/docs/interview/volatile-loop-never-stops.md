---
title: "Vì sao bỏ volatile khiến thread chạy vòng lặp mãi không dừng? — Deep Dive"
description: "Một câu hỏi phỏng vấn concurrency kinh điển: một thread set cờ boolean stop = true, nhưng thread đang chạy vòng lặp while(!stop) không bao giờ thấy và chạy mãi mãi. Mổ xẻ visibility, Java Memory Model, CPU cache, happens-before, vì sao volatile sửa được, và vì sao 'chạy đúng trên máy tôi' là cái bẫy nguy hiểm nhất."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)](#2-câu-trả-lời-30-giây-nếu-phỏng-vấn-hỏi-nhanh)
- [3. Tái hiện bug — code chạy mãi không dừng](#3-tái-hiện-bug--code-chạy-mãi-không-dừng)
- [4. Hiểu lầm cốt lõi: "ghi xong là thread khác thấy ngay"](#4-hiểu-lầm-cốt-lõi-ghi-xong-là-thread-khác-thấy-ngay)
- [5. Mỗi CPU core có cache riêng — gốc rễ của visibility](#5-mỗi-cpu-core-có-cache-riêng--gốc-rễ-của-visibility)
- [6. Thủ phạm thứ hai: JIT hoisting biến ra ngoài vòng lặp](#6-thủ-phạm-thứ-hai-jit-hoisting-biến-ra-ngoài-vòng-lặp)
- [7. Java Memory Model & happens-before](#7-java-memory-model--happens-before)
- [8. volatile sửa được gì — và không sửa được gì](#8-volatile-sửa-được-gì--và-không-sửa-được-gì)
- [9. Vì sao "chạy đúng trên máy tôi" là cái bẫy](#9-vì-sao-chạy-đúng-trên-máy-tôi-là-cái-bẫy)
- [10. Các cách sửa đúng — volatile, AtomicBoolean, synchronized](#10-các-cách-sửa-đúng--volatile-atomicboolean-synchronized)
- [11. volatile KHÔNG đủ khi nào](#11-volatile-không-đủ-khi-nào)
- [12. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp](#12-câu-hỏi-đào-sâu-mà-người-phỏng-vấn-sẽ-hỏi-tiếp)
- [13. Tóm tắt — Cheat sheet & 3 nguyên tắc](#13-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi có một thread chạy vòng lặp `while (!stop) { ... }`. Một thread khác sau vài giây gọi `stop = true` để yêu cầu nó dừng. Nhưng thread kia **không bao giờ dừng** — nó chạy mãi mãi, dù tôi chắc chắn đã set `stop = true`. Lạ hơn nữa: khi tôi thêm một dòng `System.out.println` vào vòng lặp, hoặc chạy với cờ `-Xint`, thì nó lại dừng được. Tại sao? Và sửa thế nào cho đúng?"*

Đây là câu hỏi tách biệt **người chỉ biết "synchronized = thread-safe"** với **người thật sự hiểu mô hình bộ nhớ của Java**. Người mới sẽ nói *"chắc do JVM lỗi"* hoặc *"thêm `Thread.sleep` vào là được"*. Người hiểu sâu sẽ hỏi ngược lại ngay: **"Thread đọc `stop` có gì đảm bảo nó nhìn thấy giá trị mà thread kia vừa ghi không? Câu trả lời là: KHÔNG, trừ khi bạn tạo ra quan hệ happens-before."**

> [!IMPORTANT]
> Mấu chốt: vấn đề ở đây **không phải race condition** (hai thread tranh nhau ghi), mà là **visibility** (khả năng nhìn thấy). Thread A ghi `stop = true` vào bộ nhớ của nó; thread B đọc `stop` từ bộ nhớ của nó. Java **không hứa** rằng giá trị A ghi sẽ "bay sang" cho B thấy — trừ khi có một cơ chế đồng bộ (volatile, synchronized, lock...). Đây gọi là **visibility problem**.

---

## 2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)

> Biến `stop` không khai báo `volatile`. Java Memory Model (JMM) cho phép mỗi thread giữ một **bản sao cục bộ** của biến (trong CPU cache / thanh ghi), và cho phép JIT compiler **hoisting** (kéo) việc đọc `stop` ra ngoài vòng lặp vì nó "thấy" trong phạm vi thread đó `stop` không hề đổi. Kết quả: thread B đọc một bản `stop = false` cũ mãi mãi, không bao giờ thấy giá trị `true` mà thread A ghi → vòng lặp vô tận.
>
> Sửa: khai báo `volatile boolean stop`. `volatile` đảm bảo **mọi lần đọc đều lấy từ bộ nhớ chính** (không cache), **mọi lần ghi đều flush ngay**, và tạo quan hệ **happens-before** giữa ghi và đọc → thread B chắc chắn thấy `true`. Việc thêm `println` "vô tình sửa được" vì bên trong `println` có `synchronized` tạo memory barrier — đó là sửa bằng tác dụng phụ, không phải sửa đúng.

Phần còn lại của doc giải thích **tại sao** JMM lại cho phép như vậy, và **các cơ chế** đảm bảo visibility mà một câu trả lời sâu cần đề cập.

---

## 3. Tái hiện bug — code chạy mãi không dừng

Đây là đoạn code kinh điển. Trên hầu hết JVM production (server VM + JIT bật), nó **treo vĩnh viễn**:

```java
public class StopFlagDemo {
    // ❌ THIẾU volatile
    private static boolean stop = false;

    public static void main(String[] args) throws InterruptedException {
        Thread worker = new Thread(() -> {
            long count = 0;
            while (!stop) {      // đọc stop liên tục
                count++;
            }
            System.out.println("Đã dừng sau " + count + " vòng");
        });

        worker.start();
        Thread.sleep(1000);      // để worker chạy 1 giây

        stop = true;             // main thread ra lệnh dừng
        System.out.println("main: đã set stop = true");
        // ... nhưng worker KHÔNG BAO GIỜ in "Đã dừng" → treo
    }
}
```

Hành vi quan sát được rất "ma quái":

| Điều kiện chạy | Kết quả | Vì sao |
|----------------|---------|--------|
| `java StopFlagDemo` (server JIT, mặc định) | **Treo mãi mãi** | JIT hoisting + cache → worker đọc `false` mãi |
| Thêm `System.out.println(count)` trong vòng lặp | Thường **dừng được** | `println` có `synchronized` → memory barrier |
| Chạy `java -Xint StopFlagDemo` (tắt JIT) | Thường **dừng được** (chậm) | Không có JIT hoisting; vẫn may rủi về cache |
| Thêm `Thread.sleep(1)` trong vòng lặp | Thường **dừng được** | `sleep` là điểm đồng bộ, cache có cơ hội refresh |
| Khai báo `volatile boolean stop` | **Luôn dừng đúng** | Đảm bảo bởi JMM |

> [!WARNING]
> Đừng để mấy "fix vô tình" (thêm `println`, `sleep`) đánh lừa bạn. Chúng làm bug **biến mất một cách tình cờ** vì có chứa memory barrier ẩn, nhưng code vẫn **sai về mặt JMM**. Đổi JVM, đổi version Java, đổi kiến trúc CPU là bug quay lại. Đây chính là loại bug "Heisenbug" khó chịu nhất.

---

## 4. Hiểu lầm cốt lõi: "ghi xong là thread khác thấy ngay"

Nhiều người hình dung bộ nhớ như một bảng trắng dùng chung mà ai cũng nhìn thấy tức thì:

```diagram
❌ Mô hình sai (mô hình "bộ nhớ phẳng"):

   Thread A  ──ghi stop=true──►  ┌─────────────┐
                                 │  stop=true  │  ◄── Thread B đọc → thấy true ngay
                                 └─────────────┘
        "Ghi là thấy, đơn giản mà!"
```

Thực tế phần cứng và compiler hiện đại **không hề** hoạt động như vậy. Mô hình đúng có nhiều tầng đệm mà mỗi thread nhìn qua đó:

```diagram
✅ Mô hình đúng (có cache + reorder):

   Thread A (core 0)              Thread B (core 1)
   ┌──────────────┐              ┌──────────────┐
   │ thanh ghi    │              │ thanh ghi    │  ◄── B có thể giữ stop trong
   │ store buffer │              │  stop=false  │      thanh ghi suốt vòng lặp
   │ L1/L2 cache  │              │ L1/L2 cache  │
   └──────┬───────┘              └──────┬───────┘
          │ (chưa chắc flush)           │ (chưa chắc reload)
          ▼                             ▼
   ┌────────────────────────────────────────────┐
   │            BỘ NHỚ CHÍNH (RAM)               │
   │   stop = false  →  (lúc nào đó) true        │
   └────────────────────────────────────────────┘
```

Khi A ghi `stop = true`, giá trị đó có thể nằm trong **store buffer** hay **cache L1 của core 0** một lúc trước khi xuống RAM. Trong khi đó B (chạy trên core khác) có thể đang đọc từ **cache của nó** hoặc thậm chí từ **một thanh ghi** giữ sẵn `false`. Không có gì ép hai bên đồng bộ — **trừ khi bạn yêu cầu rõ ràng**.

> [!NOTE]
> JMM cố tình "lỏng" như vậy để **cho phép tối ưu hóa**. Nếu mọi lần ghi đều phải flush ngay xuống RAM và mọi lần đọc đều phải vào RAM, code đa luồng sẽ chậm khủng khiếp. JMM nói: *"Tôi chỉ đảm bảo visibility tại các điểm đồng bộ bạn chỉ định. Còn lại tôi được tự do tối ưu."* `volatile`/`synchronized` chính là cách bạn "chỉ định điểm đồng bộ".

---

## 5. Mỗi CPU core có cache riêng — gốc rễ của visibility

Trên CPU đa nhân, mỗi core có cache riêng (L1, L2), chia sẻ L3. Tốc độ chênh nhau khủng khiếp — đó là lý do CPU **không muốn** chạm RAM nếu không bắt buộc:

| Nơi đọc/ghi 1 biến | Độ trễ điển hình | So với L1 |
|--------------------|-----------------:|----------:|
| Thanh ghi (register) | < 1 ns | < 1× |
| L1 cache | ~1 ns | 1× |
| L2 cache | ~4 ns | ~4× |
| L3 cache (shared) | ~15 ns | ~15× |
| Bộ nhớ chính (RAM) | ~100 ns | ~100× |

Vì RAM chậm gấp ~100 lần L1, CPU **luôn ưu tiên đọc/ghi trong cache** và chỉ đồng bộ xuống RAM khi cần. Giao thức cache coherence (như MESI) sẽ đồng bộ cache giữa các core — **nhưng** compiler và CPU vẫn được phép trì hoãn, gộp, hoặc bỏ qua bằng cách giữ giá trị trong **thanh ghi** (thanh ghi không nằm trong giao thức coherence). Khi `stop` được JIT giữ trong một thanh ghi của core 1, thay đổi từ core 0 **không bao giờ** tới được nó.

> [!IMPORTANT]
> Phân biệt hai tầng:
> - **Cache coherence (MESI)** là cơ chế phần cứng giữ các *cache* đồng bộ — thường khá nhanh.
> - Nhưng giá trị có thể bị giữ trong **thanh ghi** hoặc bị **JIT loại bỏ hẳn việc đọc lại** — tầng này phần cứng không cứu được. Đây mới là thủ phạm chính khiến vòng lặp treo vĩnh viễn, chứ không chỉ là "cache chưa kịp đồng bộ".

---

## 6. Thủ phạm thứ hai: JIT hoisting biến ra ngoài vòng lặp

Đây là phần "ăn điểm" trong phỏng vấn mà ít người nói tới. Visibility do cache chỉ là một nửa câu chuyện. Nửa còn lại — và thường là nguyên nhân khiến vòng lặp treo **tuyệt đối** chứ không phải "chậm vài giây" — là **tối ưu hóa của JIT compiler**.

JIT nhìn vào vòng lặp `while (!stop) { count++; }`. Trong phạm vi thread này, nó **không thấy ai sửa `stop`**. Theo quy tắc của JMM, JIT được phép giả định `stop` không đổi và **kéo việc đọc `stop` ra ngoài vòng lặp** (loop hoisting):

```java
// Code bạn viết:
while (!stop) {
    count++;
}

// Sau khi JIT tối ưu (tương đương):
boolean tmp = stop;        // đọc 1 LẦN DUY NHẤT
if (!tmp) {
    while (true) {         // vòng lặp vô tận thật sự!
        count++;
    }
}
```

Sau biến đổi này, dù `stop` trong RAM có đổi thành `true`, vòng lặp cũng **không bao giờ đọc lại** — nó đã trở thành `while (true)`. Đây là lý do `-Xint` (tắt JIT) thường làm bug biến mất: không có JIT thì không có hoisting.

```diagram
Vì sao JIT được phép làm vậy?
   Trong CHỈ một thread, "stop không đổi" là đúng.
   JMM nói: "Tối ưu trong phạm vi thread cứ làm thoải mái,
            miễn là kết quả single-thread không đổi."
   → JIT không có nghĩa vụ đoán rằng thread KHÁC sẽ sửa stop.
   → Muốn nó biết, bạn PHẢI khai báo volatile.
```

> [!TIP]
> Khi gặp "vòng lặp treo do thiếu volatile", hãy nói cả hai tầng: **(1) visibility do CPU cache/thanh ghi**, và **(2) JIT hoisting biến đọc ra ngoài vòng lặp**. Nhắc tới hoisting cho thấy bạn hiểu rằng đây không chỉ là "cache chậm đồng bộ" mà là compiler có quyền *loại bỏ hẳn* việc đọc lại.

---

## 7. Java Memory Model & happens-before

JMM (đặc tả trong JLS Chapter 17) định nghĩa chính xác **khi nào** một thao tác ghi của thread này được đảm bảo nhìn thấy bởi thread khác. Công cụ trung tâm là quan hệ **happens-before**.

Nếu hành động X *happens-before* hành động Y, thì mọi thứ X ghi đều **được đảm bảo nhìn thấy** tại Y. Nếu **không** có happens-before giữa hai thao tác trên hai thread, JMM **không đảm bảo gì** về thứ tự hay visibility — và đó chính xác là tình huống bug của ta.

Các nguồn tạo happens-before quan trọng:

| Quan hệ happens-before | Ý nghĩa |
|------------------------|---------|
| Trong cùng 1 thread | Câu lệnh trước happens-before câu sau (program order) |
| `volatile` write → read | Ghi volatile happens-before mọi lần đọc volatile sau đó (trên biến đó) |
| `unlock` → `lock` | Mở khóa monitor happens-before lần khóa kế tiếp cùng monitor |
| `Thread.start()` | Gọi `start()` happens-before mọi việc trong thread con |
| `Thread.join()` | Mọi việc trong thread con happens-before `join()` trả về |
| `final` field | Khởi tạo final field trong constructor happens-before khi object được publish đúng cách |

```diagram
Trong code bug của ta:
   main:    stop = true            (thao tác ghi)
   worker:  while (!stop) ...       (thao tác đọc)

   Có happens-before giữa hai cái này không?
   → KHÔNG. stop không volatile, không synchronized,
     không qua start/join nào nối chúng lại.
   → JMM: "Tôi không hứa worker thấy giá trị true." → treo.
```

> [!NOTE]
> Đây là lý do câu trả lời "thêm `sleep` cho nó nghỉ" là sai bản chất: `Thread.sleep` **không** tạo happens-before lên biến `stop`. Nó chỉ tình cờ tạo cơ hội để cache đồng bộ trên một số JVM/CPU. Bug có thể quay lại bất cứ lúc nào.

---

## 8. volatile sửa được gì — và không sửa được gì

Khai báo `volatile` cho biến `stop` tạo ra ba đảm bảo:

```java
private static volatile boolean stop = false;   // ✅ chỉ thêm 1 từ khóa
```

```diagram
volatile boolean stop:
  1. VISIBILITY:  mọi lần đọc lấy thẳng từ bộ nhớ chính (không dùng bản cache cũ),
                  mọi lần ghi flush ngay xuống bộ nhớ chính.
  2. NO HOISTING: JIT KHÔNG được kéo việc đọc volatile ra ngoài vòng lặp
                  → mỗi vòng đều đọc lại stop thật sự.
  3. HAPPENS-BEFORE: ghi volatile happens-before lần đọc volatile sau đó
                  → mọi thứ ghi TRƯỚC khi ghi volatile cũng được thấy (memory barrier).
```

Đảm bảo thứ 3 mạnh hơn bạn tưởng — nó là **memory barrier**: mọi ghi thường (non-volatile) **trước** lần ghi volatile cũng được flush, và mọi đọc **sau** lần đọc volatile cũng được refresh. Đây là nền tảng của "happens-before piggyback".

Nhưng `volatile` **KHÔNG** đảm bảo **atomicity của thao tác phức hợp**:

```java
volatile int counter = 0;
counter++;   // ❌ KHÔNG atomic! Đây là 3 bước: đọc → +1 → ghi
             //    Hai thread có thể cùng đọc 5, cùng ghi 6 → mất 1 lần đếm
```

| Việc | `volatile` có lo được? |
|------|------------------------|
| Một thread ghi, các thread khác đọc (cờ stop, flag config) | ✅ Có — đây đúng là use case của volatile |
| Visibility của giá trị mới nhất | ✅ Có |
| Chặn JIT hoisting / reorder quanh biến đó | ✅ Có |
| `count++`, `count += n` (đọc-sửa-ghi) | ❌ Không — cần `AtomicInteger` hoặc `synchronized` |
| Cập nhật nhiều biến cùng lúc một cách nhất quán | ❌ Không — cần `synchronized`/lock |

> [!IMPORTANT]
> Quy tắc nhớ: **`volatile` lo VISIBILITY, không lo ATOMICITY.** Cờ `boolean stop` chỉ có một thread ghi và các thread khác đọc → đúng kiểu visibility → `volatile` là lời giải hoàn hảo và rẻ. Còn bộ đếm bị nhiều thread cùng `++` thì `volatile` không cứu được.

---

## 9. Vì sao "chạy đúng trên máy tôi" là cái bẫy

Đây là điểm khiến loại bug này cực kỳ nguy hiểm trong thực tế:

```diagram
Trên laptop dev:                    Trên server production:
  • Client JVM hoặc ít core           • Server JVM, JIT C2 tối ưu mạnh
  • JIT chưa kịp "ấm" để hoisting      • Chạy lâu → JIT đã hoisting biến
  • println debug khắp nơi (barrier)   • Code sạch, không có barrier ẩn
  → "Chạy ngon, dừng đúng!"            → Treo sau vài phút uptime
```

Cùng một bytecode, hành vi khác nhau vì:
- **JIT cần thời gian "ấm"**: vòng lặp phải chạy đủ nhiều lần (thường ~10,000) thì C2 mới compile và hoisting. Test ngắn trên máy dev không kích hoạt được.
- **Server VM tối ưu mạnh hơn Client VM**.
- **Kiến trúc CPU khác nhau** (x86 có mô hình bộ nhớ mạnh hơn ARM): cùng code thiếu volatile, x86 có thể "may mắn" chạy đúng, còn ARM (mô hình bộ nhớ lỏng hơn) thì hỏng — đây là nỗi đau kinh điển khi port app sang Apple Silicon / AWS Graviton.

> [!WARNING]
> Không bao giờ kết luận code đa luồng đúng chỉ vì "test thấy chạy ổn". Bug visibility **không xác định** (non-deterministic): nó phụ thuộc timing, JIT state, CPU. Một test pass 1000 lần vẫn có thể hỏng ở lần 1001 trên production. Đúng/sai của code concurrency phải suy luận theo **JMM**, không theo quan sát.

---

## 10. Các cách sửa đúng — volatile, AtomicBoolean, synchronized

Có nhiều cách, mỗi cách hợp với một ngữ cảnh:

### 10.1. `volatile` — đúng nhất cho cờ stop

```java
private static volatile boolean stop = false;

while (!stop) { ... }   // mỗi vòng đọc lại stop thật; thấy true ngay khi được set
```

Rẻ nhất, đúng nhất cho trường hợp **một ghi, nhiều đọc**, không cần atomicity.

### 10.2. `AtomicBoolean` — khi cần cả atomicity

```java
private static final AtomicBoolean stop = new AtomicBoolean(false);

while (!stop.get()) { ... }
// thread khác: stop.set(true);
// hoặc compareAndSet nếu cần "chỉ ai set đầu tiên mới thắng"
```

Dùng khi bạn cần thao tác nguyên tử như `compareAndSet`, hoặc muốn API rõ ràng. `AtomicBoolean` cũng bảo đảm visibility như volatile.

### 10.3. `synchronized` quanh đọc/ghi

```java
private static boolean stop = false;

synchronized boolean isStopped() { return stop; }
synchronized void requestStop() { stop = true; }

while (!isStopped()) { ... }
```

Đúng (vì unlock→lock tạo happens-before) nhưng **nặng hơn** volatile cho một cờ đơn giản, và dễ gây contention nếu vòng lặp nóng.

### 10.4. Cách "chuẩn" của Java cho việc dừng thread: interrupt

```java
Thread worker = new Thread(() -> {
    while (!Thread.currentThread().isInterrupted()) {
        // làm việc
    }
});
worker.start();
// ...
worker.interrupt();   // cơ chế hợp tác chuẩn để yêu cầu dừng
```

`interrupt()` là cơ chế được thiết kế sẵn cho "yêu cầu dừng hợp tác", và xử lý được cả trường hợp thread đang kẹt trong `sleep`/`wait` (ném `InterruptedException`).

> [!TIP]
> Thứ tự ưu tiên thực tế: với **cờ dừng đơn giản** → `volatile boolean` (gọn, rõ). Khi cần **CAS / atomic** → `AtomicBoolean`. Khi muốn dừng cả thread đang **blocking** (`sleep`/`wait`/`I/O`) → dùng **interrupt**. Tuyệt đối tránh `Thread.stop()` (deprecated, không an toàn).

---

## 11. volatile KHÔNG đủ khi nào

Để câu trả lời thật đầy đủ, cần biết ranh giới của `volatile`:

| Tình huống | volatile đủ? | Dùng gì thay thế |
|------------|:------------:|------------------|
| Cờ `boolean stop` (1 ghi, n đọc) | ✅ Đủ | — |
| Đọc/ghi một reference đã khởi tạo xong | ✅ Đủ | — |
| `counter++` nhiều thread | ❌ Không | `AtomicInteger`, `LongAdder`, `synchronized` |
| Kiểm tra-rồi-hành-động (check-then-act) | ❌ Không | `synchronized`, `compareAndSet` |
| Cập nhật 2+ biến phải nhất quán với nhau | ❌ Không | `synchronized`/`ReentrantLock` |
| Lazy init "double-checked locking" | ✅ Cần volatile cho field | volatile + synchronized (hoặc holder idiom) |

```java
// ❌ volatile KHÔNG cứu được check-then-act:
volatile int balance = 100;
if (balance >= 50) {     // thread A và B cùng thấy true
    balance -= 50;       // cả hai cùng trừ → balance sai
}
// → cần synchronized hoặc compareAndSet
```

> [!NOTE]
> Một use case mà `volatile` **bắt buộc**: pattern **double-checked locking** để lazy-init singleton. Nếu field `instance` không `volatile`, một thread có thể thấy object **đã được publish nhưng chưa khởi tạo xong** (do reorder giữa "cấp phát" và "gán reference"). `volatile` chặn reorder đó.

---

## 12. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp

> **"Vì sao thêm `System.out.println` lại làm bug biến mất?"**
`System.out` là `PrintStream`, các method ghi của nó `synchronized`. Vào/ra khối `synchronized` tạo memory barrier (unlock→lock happens-before) → ép refresh `stop` từ bộ nhớ chính, và chặn JIT hoisting quanh đó. Đây là sửa bằng **tác dụng phụ**, không phải chủ đích — bỏ `println` đi là bug quay lại.

> **"`volatile` có làm chậm không?"**
Có chút chi phí (đọc/ghi không tận dụng được cache tối đa, có memory barrier), nhưng với một cờ `boolean` thì không đáng kể. Đừng vì sợ chậm mà bỏ `volatile` ở chỗ cần — sai còn tệ hơn chậm.

> **"x86 và ARM khác nhau thế nào ở đây?"**
x86 có mô hình bộ nhớ **mạnh** (TSO — gần như không reorder store-store), nên code thiếu volatile đôi khi "may mắn" chạy đúng. ARM/Power có mô hình **lỏng** hơn, reorder nhiều hơn → cùng code đó hỏng. Đây là lý do bug "ẩn" trên x86 lại lộ ra khi chạy trên Apple Silicon hay AWS Graviton.

> **"`volatile` với `synchronized` khác gì?"**
`volatile` chỉ lo **visibility + ordering** cho một biến, không khóa, không atomic cho thao tác phức hợp. `synchronized` lo cả **mutual exclusion (atomicity)** lẫn visibility, nhưng nặng hơn và có thể gây contention. Cờ stop chỉ cần visibility → `volatile`.

> **"Đã `volatile` rồi thì `count++` trong vòng lặp có an toàn không?"**
Không, nếu `count` được nhiều thread cùng `++`. Trong code mẫu, `count` là biến cục bộ của một thread duy nhất nên không sao; nhưng nếu chia sẻ thì cần `AtomicLong`.

---

## 13. Tóm tắt — Cheat sheet & 3 nguyên tắc

**Cheat sheet — chẩn đoán "vòng lặp không dừng":**

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| Worker chạy mãi dù đã set cờ | Cờ không `volatile` → visibility + JIT hoisting | Thêm `volatile` |
| Dừng được khi thêm `println`/`sleep` | Memory barrier ẩn từ `synchronized` bên trong | Đừng tin — sửa bằng `volatile` thật |
| Chạy đúng trên dev, treo trên prod | JIT đã ấm + hoisting trên server VM | `volatile` (suy luận theo JMM, không theo test) |
| Treo trên ARM, chạy trên x86 | Mô hình bộ nhớ ARM lỏng hơn | `volatile` |
| Mất số đếm dù đã `volatile` | `volatile` không lo atomicity của `++` | `AtomicInteger`/`synchronized` |

**Ba nguyên tắc để không bao giờ dính lại:**

1. **Chia sẻ biến giữa các thread = phải có cơ chế đồng bộ.** Mặc định JMM **không** đảm bảo visibility. Không `volatile`/`synchronized`/atomic = không có happens-before = không có đảm bảo.
2. **`volatile` lo visibility + ordering, KHÔNG lo atomicity.** Cờ một-ghi-nhiều-đọc → `volatile`. Đọc-sửa-ghi (`++`) → atomic/lock.
3. **Đúng/sai của concurrency suy luận theo JMM, không theo "test thấy chạy ổn".** Bug visibility là Heisenbug: phụ thuộc JIT, CPU, timing. "Chạy đúng trên máy tôi" không chứng minh được gì.

> [!IMPORTANT]
> Câu trả lời ghi điểm trọn vẹn gồm bốn ý: **(1)** đây là vấn đề *visibility* chứ không phải race; **(2)** nguyên nhân gồm cả *CPU cache/thanh ghi* lẫn *JIT hoisting*; **(3)** JMM chỉ đảm bảo qua *happens-before*, mà cờ thường không tạo ra; **(4)** `volatile` là fix đúng và rẻ, còn `println`/`sleep` chỉ là sửa nhờ tác dụng phụ.
