---
title: "Virtual Threads (Project Loom)"
description: "Hướng dẫn thực hành Virtual Threads từ JDK 21: cơ chế hoạt động, giới hạn, pinning theo từng phiên bản JDK, kiểm soát downstream và chiến lược migration an toàn."
---

<Callout type="info" title="Phạm vi phiên bản">
  Virtual Threads là tính năng chính thức từ <strong>JDK 21</strong>. Tài liệu phân biệt rõ JDK 21–23 với JDK 24+ vì JDK 24 đã loại bỏ pinning do <code>synchronized</code>. <code>ScopedValue</code> là API chính thức từ JDK 25; Structured Concurrency vẫn là preview và API thay đổi giữa các bản JDK.
</Callout>

Virtual thread là một `java.lang.Thread` nhẹ do JVM quản lý. Nó phù hợp khi một ứng dụng cần xử lý rất nhiều tác vụ đồng thời mà phần lớn thời gian của mỗi tác vụ là **chờ I/O**: chờ database, HTTP API, Redis, message broker, socket hoặc lock.

Điểm cần nhớ ngay từ đầu: Virtual Threads giúp **tăng throughput khi có nhiều việc chờ**, chứ không làm CPU chạy nhanh hơn và không xoá các giới hạn của database, network hay memory.

## Mục lục

- [Kết luận nhanh: có thay thế hoàn toàn thread thường không?](#kết-luận-nhanh-có-thay-thế-hoàn-toàn-thread-thường-không)
- [Bài toán mà Virtual Threads giải quyết](#bài-toán-mà-virtual-threads-giải-quyết)
- [Mô hình hoạt động: virtual thread, carrier và blocking I/O](#mô-hình-hoạt-động-virtual-thread-carrier-và-blocking-io)
  - [Platform thread và virtual thread khác nhau ở đâu?](#platform-thread-và-virtual-thread-khác-nhau-ở-đâu)
  - [Mount, unmount và resume](#mount-unmount-và-resume)
  - [Một carrier chạy nhiều VT bằng cách nào?](#một-carrier-chạy-nhiều-vt-bằng-cách-nào)
  - [Blocking nào được hưởng lợi?](#blocking-nào-được-hưởng-lợi)
- [Khi nào nên chọn Virtual Thread, Platform Thread hoặc Reactive?](#khi-nào-nên-chọn-virtual-thread-platform-thread-hoặc-reactive)
- [API cơ bản trong JDK 21](#api-cơ-bản-trong-jdk-21)
  - [Tạo một virtual thread](#tạo-một-virtual-thread)
  - [Một virtual thread cho mỗi task](#một-virtual-thread-cho-mỗi-task)
  - [Fan-out các I/O call độc lập](#fan-out-các-io-call-độc-lập)
- [Không pool virtual thread, nhưng phải giới hạn tài nguyên](#không-pool-virtual-thread-nhưng-phải-giới-hạn-tài-nguyên)
  - [Vì sao fixed thread pool từng là giới hạn concurrency?](#vì-sao-fixed-thread-pool-từng-là-giới-hạn-concurrency)
  - [Bulkhead bằng Semaphore](#bulkhead-bằng-semaphore)
  - [Timeout và cancellation vẫn là trách nhiệm của ứng dụng](#timeout-và-cancellation-vẫn-là-trách-nhiệm-của-ứng-dụng)
- [CPU-bound work và blocking không hợp tác](#cpu-bound-work-và-blocking-không-hợp-tác)
- [Pinning: điều gì còn đúng theo từng JDK?](#pinning-điều-gì-còn-đúng-theo-từng-jdk)
  - [JDK 21–23: synchronized có thể pin](#jdk-21-23-synchronized-có-thể-pin)
  - [JDK 24+: synchronized không còn pin](#jdk-24-synchronized-không-còn-pin)
  - [Native và foreign function vẫn cần kiểm tra](#native-và-foreign-function-vẫn-cần-kiểm-tra)
- [ThreadLocal, ScopedValue và context request](#threadlocal-scopedvalue-và-context-request)
- [Structured Concurrency: dùng khi một request tách thành nhiều subtask](#structured-concurrency-dùng-khi-một-request-tách-thành-nhiều-subtask)
- [Migration từ thread pool sang Virtual Threads](#migration-từ-thread-pool-sang-virtual-threads)
  - [Những migration an toàn nhất](#những-migration-an-toàn-nhất)
  - [Những thứ không nên đổi máy móc](#những-thứ-không-nên-đổi-máy-móc)
  - [Spring Boot](#spring-boot)
- [Quan sát và chẩn đoán production](#quan-sát-và-chẩn-đoán-production)
- [Anti-patterns thường gặp](#anti-patterns-thường-gặp)
- [Checklist trước khi rollout](#checklist-trước-khi-rollout)
- [Cheat sheet](#cheat-sheet)

---

## Kết luận nhanh: có thay thế hoàn toàn thread thường không?

**Không.** Virtual thread là lựa chọn mặc định tốt cho mô hình *thread-per-request* hoặc *thread-per-task* có nhiều blocking I/O. Nhưng platform thread vẫn cần thiết, và thực tế chính các platform thread đang đóng vai trò **carrier** để chạy virtual thread.

| Tình huống | Lựa chọn phù hợp | Lý do |
|---|---|---|
| API service gọi JDBC, HTTP, Redis hoặc message broker | **Virtual thread** | Một request có thể block theo kiểu đồng bộ mà không giữ cứng một OS thread trong lúc chờ. |
| Xử lý ảnh, nén, mã hoá, ML, tính toán số học | **Platform-thread pool có giới hạn** | Công việc dùng CPU liên tục; tạo nhiều VT không tạo thêm CPU core. |
| Gọi JNI, foreign function hoặc thư viện native blocking | Cần benchmark; thường tách riêng | VT có thể bị pin vào carrier trong lúc chạy native code. |
| Streaming dài, xử lý luồng dữ liệu và backpressure end-to-end | Reactive có thể phù hợp hơn | VT không tự cung cấp backpressure hay cơ chế điều phối demand. |
| Hệ thống reactive đã ổn định | Không cần đổi chỉ vì Loom | Lợi ích migration có thể không bù chi phí thay đổi và rủi ro vận hành. |

<Callout type="idea" title="Quy tắc chọn nhanh">
  Nếu mỗi task chủ yếu là “gọi I/O rồi chờ kết quả”, hãy ưu tiên Virtual Threads. Nếu task chủ yếu là “tính liên tục trên CPU”, hãy giới hạn độ song song theo số core thay vì tăng số thread.
</Callout>

## Bài toán mà Virtual Threads giải quyết

Trước JDK 21, một Java `Thread` thông thường tương ứng gần như 1:1 với một OS thread. Khi request gọi JDBC và chờ database trong 100 ms, OS thread đó cũng bị giữ trong 100 ms. Để phục vụ thêm request, server phải có thêm OS thread.

Ví dụ một service có 200 request đồng thời. Mỗi request mất 5 ms CPU nhưng chờ database 95 ms:

```text
Mỗi request: [CPU 5 ms] ── [chờ DB 95 ms] ── [CPU 5 ms]

Platform thread pool 200 threads:
- 200 OS threads phần lớn đang chờ DB.
- Muốn nhận thêm request thường phải tăng pool và tăng OS resources.

Virtual thread:
- Request chờ DB → virtual thread được tạm dừng.
- Carrier thread được rảnh để chạy request khác.
- Có thể giữ nhiều request đang chờ hơn với ít OS thread hơn.
```

Virtual Threads không rút thời gian DB trả lời từ 95 ms xuống 10 ms. Chúng giảm số OS thread bị lãng phí khi chờ. Vì thế lợi ích chính thường là **throughput cao hơn ở mức concurrency lớn**, không phải mỗi request tự nhiên có latency thấp hơn.

## Mô hình hoạt động: virtual thread, carrier và blocking I/O

### Platform thread và virtual thread khác nhau ở đâu?

| Thuộc tính | Platform thread | Virtual thread |
|---|---|---|
| Kiểu Java | `java.lang.Thread` | Cũng là `java.lang.Thread` |
| Quan hệ với OS thread | Gần 1:1 trong toàn bộ vòng đời | Nhiều VT được multiplex trên ít carrier threads |
| Stack | OS-managed, chi phí tương đối lớn | JVM-managed, tăng dần theo nhu cầu và nằm trên heap |
| Hợp với | Mọi loại task, nhất là CPU-bound/affinity | Nhiều task I/O-bound, blocking |
| Có cần pool? | Thường cần vì OS thread là tài nguyên hiếm | Không pool VT; tạo một VT cho mỗi concurrent task |

```text
Nhiều virtual thread dùng chung một nhóm platform thread carrier:

 VT request A ──┐
 VT request B ──┼──► JVM scheduler ──► Carrier 1 ──► OS thread
 VT request C ──┤                        Carrier 2 ──► OS thread
 VT request D ──┘                        Carrier 3 ──► OS thread

Khi VT request A chờ socket/JDBC I/O được JVM hỗ trợ:
VT A unmount khỏi Carrier 1 → Carrier 1 chạy VT request D.
```

Carrier là platform thread thật. Hệ điều hành vẫn chỉ schedule platform thread; JVM quyết định virtual thread nào được mount lên carrier nào. Một virtual thread không có “OS thread riêng” cố định.

### Mount, unmount và resume

Một VT ở một thời điểm có thể đang chạy, đang chờ, hoặc đã kết thúc:

```text
1. VT được mount lên carrier và chạy Java code.
2. VT gọi blocking operation, ví dụ socket read hoặc Semaphore.acquire().
3. JVM suspend VT; trạng thái call stack của VT được giữ để tiếp tục sau.
4. VT unmount; carrier được trả về scheduler để chạy VT khác.
5. Khi I/O/permit sẵn sàng, JVM mount lại VT lên một carrier bất kỳ.
6. VT tiếp tục ngay sau lệnh blocking, như thể chưa từng bị tạm dừng.
```

```text
Thời gian ─────────────────────────────────────────────────────────►

Carrier 1:  [VT-A xử lý] [VT-B xử lý] [VT-C xử lý] [VT-A tiếp tục]
Carrier 2:  [VT-D xử lý] [VT-E xử lý] [VT-F xử lý]

VT-A:       [run] ── socket.read() ── [waiting, unmounted] ── [run]
```

Code ứng dụng vẫn là code tuần tự, blocking và dễ đọc. Việc suspend/resume là chi tiết của JVM; không nên dựa vào carrier cụ thể nào đang chạy VT.

### Một carrier chạy nhiều VT bằng cách nào?

Nói chính xác, một carrier **không chạy nhiều VT cùng lúc**. Tại một thời điểm nó chỉ thực thi một VT, giống như một CPU core chỉ thực thi một luồng lệnh tại một thời điểm. JVM tạo cảm giác một carrier “phục vụ nhiều VT” bằng cách chuyển carrier sang VT khác ngay khi VT hiện tại không còn làm việc hữu ích mà đang chờ.

```text
Carrier 1:
[ chạy VT-A ] [ VT-A chờ I/O ] [ chạy VT-B ] [ chạy VT-C ] [ chạy lại VT-A ]

VT-A:
[ parse request ] ── socket.read() ── [ waiting ] ── [ xử lý response ]
```

Ví dụ, khi VT gọi `httpClient.send(...)`, nó đi qua chuỗi sau:

1. VT đang **mount** trên một carrier và chạy Java code.
2. Lời gọi HTTP phải chờ network response.
3. JVM suspend VT, giữ trạng thái cần để tiếp tục — vị trí đang chạy, local variables và call stack — trong heap.
4. VT được **unmount**. Carrier không còn bị gắn với VT này nên scheduler có thể mount một VT runnable khác lên carrier đó.
5. Khi response đến, scheduler đưa VT cũ vào hàng đợi runnable.
6. Một carrier rảnh mount lại VT. Carrier này có thể khác carrier ban đầu.

```java
void process() throws Exception {
    String token = loadToken();
    String data = callApi(token); // VT có thể unmount khi chờ network
    save(data);                   // resume xong tiếp tục chính xác tại đây
}
```

Biến `token` và vị trí thực thi sau `callApi(...)` không mất đi khi VT chờ. JVM khôi phục trạng thái đó trước khi chạy `save(data)`. Đây là lý do application code vẫn có thể viết theo kiểu blocking tuần tự, thay vì phải tự chia code thành callback/state machine.

Cơ chế chuyển này chỉ có lợi khi VT đi vào một điểm blocking mà JVM có thể unmount. Nếu VT chạy CPU liên tục thì carrier không được nhường:

```java
Thread.startVirtualThread(() -> {
    while (true) {
        calculateHash(); // CPU-bound: giữ một carrier trong lúc chạy
    }
});
```

Tạo 100.000 VT kiểu CPU-bound không tạo thêm CPU core. Chúng vẫn cạnh tranh một nhóm carrier có kích thước gần với số processor. Native/JNI hoặc foreign-function call cũng có thể khiến VT bị pin, nghĩa là VT block nhưng carrier chưa được giải phóng.

### Blocking nào được hưởng lợi?

Các blocking API chuẩn của JDK được thiết kế để làm việc tốt với virtual threads, ví dụ:

- `Thread.sleep(...)`, `LockSupport.park(...)`.
- `Object.wait(...)`, `ReentrantLock`, `Condition`, `Semaphore` và `BlockingQueue`.
- Nhiều thao tác socket/network trong `java.net` và `java.nio`.
- Các driver JDBC thuần Java thường hưởng lợi vì request chờ I/O của database.

Tuy nhiên, **không được suy diễn rằng mọi hàm “có vẻ blocking” đều unmount được**. JNI, foreign function, thư viện native, driver đặc thù và một số thao tác file/system có thể có hành vi khác theo OS và JDK. Hãy đo bằng load test/JFR với dependency thật của ứng dụng.

<Callout type="warn" title="Blocking rẻ không đồng nghĩa tài nguyên rẻ">
  Một virtual thread đang chờ `Semaphore.acquire()` không chiếm carrier, nhưng nó vẫn là object sống trong heap. Một virtual thread đang chờ JDBC không dùng carrier, nhưng vẫn có thể đang giữ transaction, socket và database connection. Đừng tạo concurrency vô hạn.
</Callout>

## Khi nào nên chọn Virtual Thread, Platform Thread hoặc Reactive?

```text
Task có phần lớn thời gian chờ I/O?
│
├─ Có
│  ├─ Request/response thông thường, API blocking? ──► Virtual Threads
│  └─ Cần stream liên tục + backpressure xuyên pipeline? ──► Cân nhắc Reactive
│
└─ Không, chủ yếu chạy CPU
   └─ Giới hạn parallelism theo số core ──► Platform-thread pool / ForkJoinPool phù hợp
```

Reactive và Virtual Threads không đối nghịch về mặt kỹ thuật. Reactive có giá trị khi cần một protocol backpressure hoặc pipeline streaming phức tạp. Virtual Threads đặc biệt hữu ích khi reactive trước đây chỉ được dùng để tránh việc blocking làm cạn servlet thread pool.

## API cơ bản trong JDK 21

### Tạo một virtual thread

Dùng `Thread.startVirtualThread` cho một tác vụ đơn lẻ, hoặc builder khi cần đặt tên.

```java
// Tạo và start ngay.
Thread thread = Thread.startVirtualThread(() -> {
    System.out.println("running on virtual thread = "
        + Thread.currentThread().isVirtual());
});

thread.join();
```

```java
// Builder hữu ích khi cần tên dễ đọc trong log, JFR và thread dump.
Thread.Builder.OfVirtual worker = Thread.ofVirtual().name("payment-", 0);

Thread first = worker.start(() -> processPayment()); // payment-0
Thread second = worker.start(() -> processPayment()); // payment-1
```

Không cần viết scheduler hoặc continuation riêng. Virtual thread dùng cùng `Thread`, interruption, `join`, stack trace và hầu hết API concurrency quen thuộc.

### Một virtual thread cho mỗi task

Khi có nhiều task, dùng `Executors.newVirtualThreadPerTaskExecutor()`:

```java
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

String loadCustomer(String id) throws Exception {
    try (ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor()) {
        Future<String> result = executor.submit(() -> customerClient.get(id));
        return result.get();
    }
}
```

Tên method có chữ `Executor`, nhưng đối tượng này **không phải thread pool**: mỗi `submit` tạo một virtual thread mới. `try-with-resources` giúp scope vòng đời các task; khi đóng executor, nó shutdown và chờ task đã submit kết thúc.

Trong service dài hạn, executor có thể được tạo một lần và đóng lúc application shutdown. Với fan-out cục bộ trong một request, tạo executor trong `try-with-resources` cũng hợp lý vì executor này nhẹ.

### Fan-out các I/O call độc lập

Hai lời gọi độc lập có thể chạy song song. Ví dụ dưới dùng API ổn định từ JDK 21:

```java
record Dashboard(Customer customer, List<Order> orders) {}

Dashboard loadDashboard(String customerId) throws Exception {
    try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
        Future<Customer> customer = executor.submit(
            () -> customerClient.get(customerId));
        Future<List<Order>> orders = executor.submit(
            () -> orderClient.findByCustomer(customerId));

        // get() block virtual thread hiện tại nếu nó cũng là VT.
        // Không cần CompletableFuture chỉ để tránh blocking.
        return new Dashboard(customer.get(), orders.get());
    }
}
```

Ví dụ này đơn giản nhưng có một điểm cần biết: nếu `customer.get()` thất bại, task `orders` có thể vẫn chạy cho đến khi executor bị đóng. Với fan-out phức tạp, cancellation/timeout chung và lifecycle con-cha, xem phần [Structured Concurrency](#structured-concurrency-dùng-khi-một-request-tách-thành-nhiều-subtask).

## Không pool virtual thread, nhưng phải giới hạn tài nguyên

### Vì sao fixed thread pool từng là giới hạn concurrency?

Với platform threads, đoạn code sau vừa là executor vừa vô tình là cơ chế giới hạn số gọi DB đồng thời:

```java
ExecutorService dbWorkers = Executors.newFixedThreadPool(50);
```

Cách này có lý vì mỗi worker là OS thread đắt. Nhưng khi đổi factory sang virtual thread mà vẫn giữ `50`, bạn chỉ tạo **50 VT đồng thời**. Lợi ích của VT bị mất, trong khi ý định thật thường là “DB chỉ chịu được 50 query đồng thời”.

Hãy diễn đạt ý định đó trực tiếp bằng một giới hạn tài nguyên.

### Bulkhead bằng Semaphore

`Semaphore` là một bulkhead: nó giới hạn số task được phép đi vào một tài nguyên hiếm cùng lúc. Task chờ permit có thể là virtual thread; nó không cần giữ carrier.

```java
import java.util.concurrent.Semaphore;

final class DatabaseGateway {
    // Chọn theo connection pool, DB capacity và load test; không theo số CPU core.
    private final Semaphore databasePermits = new Semaphore(40);

    Order loadOrder(String id) throws Exception {
        databasePermits.acquire();
        try {
            return jdbcOrderRepository.findById(id);
        } finally {
            databasePermits.release();
        }
    }
}
```

Ở biên nhận request, vẫn cần có admission control hoặc queue có giới hạn nếu traffic có thể bùng nổ. `Semaphore` bảo vệ downstream, nhưng nếu bạn tạo hàng triệu VT chỉ để chờ semaphore thì heap và latency queue vẫn sẽ tăng.

Các giới hạn thường phải độc lập:

| Tài nguyên | Cơ chế giới hạn thường dùng |
|---|---|
| JDBC connections | Connection pool size và/hoặc `Semaphore` theo use case |
| HTTP call tới một vendor | `Semaphore`, rate limiter, timeout, circuit breaker |
| CPU transform | Fixed-size executor hoặc `ForkJoinPool` có parallelism rõ ràng |
| Incoming requests | Gateway/load balancer/server queue/admission control |
| Memory queue | Bounded queue, backpressure hoặc reject policy |

### Timeout và cancellation vẫn là trách nhiệm của ứng dụng

Virtual thread không tự biết một HTTP call đã quá hạn, không tự đóng JDBC transaction, và không tự hủy API phía xa. Đặt timeout gần nơi gọi I/O và bảo đảm cleanup trong `finally`/try-with-resources.

```java
HttpRequest request = HttpRequest.newBuilder(uri)
    .timeout(Duration.ofSeconds(2))
    .GET()
    .build();

HttpResponse<String> response = httpClient.send(
    request,
    HttpResponse.BodyHandlers.ofString()
);
```

Interruption cũng cần được tôn trọng. Nếu bắt `InterruptedException`, hoặc propagate nó, hoặc restore interrupt flag rồi thoát khỏi task. Đừng nuốt exception rồi tiếp tục chạy như chưa có chuyện gì xảy ra.

```java
try {
    permits.acquire();
    // do work
} catch (InterruptedException e) {
    Thread.currentThread().interrupt();
    throw new IllegalStateException("Request was cancelled", e);
}
```

## CPU-bound work và blocking không hợp tác

Một virtual thread chỉ nhường carrier hiệu quả khi đi vào điểm blocking/yield hợp tác. Vòng lặp CPU dài không tự nhiên trở nên rẻ hơn.

```java
// Không có I/O, không có park; task này có thể chiếm một carrier trong thời gian dài.
Thread.startVirtualThread(() -> {
    for (long i = 0; i < Long.MAX_VALUE; i++) {
        digest.update(data);
    }
});
```

Nếu hàng nghìn task kiểu này chạy trên VT, chúng cạnh tranh một số carrier xấp xỉ số processor. Kết quả thường là scheduler contention và latency xấu hơn, không phải throughput tốt hơn.

Dành một executor có parallelism rõ ràng cho CPU work:

```java
int parallelism = Runtime.getRuntime().availableProcessors();
ExecutorService cpuExecutor = Executors.newFixedThreadPool(parallelism);

Future<Image> resized = cpuExecutor.submit(() -> resizeAndEncode(image));
```

Con số thực tế có thể thấp hơn số core nếu workload còn cần CPU cho GC, network và các service khác. Chọn bằng benchmark thay vì coi `availableProcessors()` là đáp án tuyệt đối.

## Pinning: điều gì còn đúng theo từng JDK?

**Pinning** xảy ra khi VT đang block nhưng không thể unmount khỏi carrier. Pinning không làm sai kết quả chương trình; nó làm giảm khả năng scale vì carrier bị giữ trong lúc đáng lẽ có thể chạy VT khác.

### JDK 21–23: synchronized có thể pin

Trong JDK 21–23, một VT đang giữ monitor của `synchronized` sẽ bị pin nếu nó thực hiện blocking operation bên trong vùng đó:

```java
// JDK 21–23: socket.read() có thể pin carrier trong lúc chờ.
synchronized (lock) {
    byte[] response = socket.getInputStream().readAllBytes();
    updateCache(response);
}
```

Với các JDK này, tránh giữ `synchronized` quanh I/O. Có thể thay bằng `ReentrantLock` nếu thật sự cần lock, hoặc tốt hơn là thu nhỏ critical section để không gọi I/O trong khi đang giữ bất kỳ lock nào.

```java
// JDK 21–23: ReentrantLock không pin theo cơ chế monitor cũ.
lock.lock();
try {
    updateSharedState(); // critical section ngắn, không gọi I/O
} finally {
    lock.unlock();
}

byte[] response = socket.getInputStream().readAllBytes();
```

### JDK 24+: synchronized không còn pin

JDK 24 đưa vào JEP 491. JVM theo dõi monitor ownership theo virtual thread thay vì carrier, nên VT có thể unmount trong `synchronized` hoặc `Object.wait()`.

Vì vậy trên **JDK 24+**, không cần thay toàn bộ `synchronized` thành `ReentrantLock` chỉ để né pinning. Hãy chọn `ReentrantLock` khi cần tính năng của nó như `tryLock`, timeout, lock interruptible hoặc nhiều condition; không phải vì `synchronized` bị coi là lỗi thời.

Dù vậy, gọi I/O khi đang giữ lock vẫn là thiết kế xấu trong nhiều trường hợp. Nó làm các task khác chờ lock lâu, gây contention và có thể giữ state không nhất quán quá lâu. JDK 24 giải quyết pinning, không giải quyết contention logic của ứng dụng.

### Native và foreign function vẫn cần kiểm tra

Trong JDK hiện đại, trường hợp pinning quan trọng còn lại là VT chạy:

- `native` method qua JNI.
- Foreign function từ Foreign Function & Memory API.
- Một số integration/thư viện có native layer hoặc hành vi OS-specific.

Nếu native call block lâu, carrier có thể không được giải phóng. Không đoán từ tên thư viện; dùng JFR và load test với workload thực tế.

<Callout type="warn" title="Đừng áp dụng lời khuyên pinning cũ cho mọi JDK">
  “Không được dùng <code>synchronized</code> với virtual thread” là lời khuyên dành cho JDK 21–23. Với JDK 24+, nó không còn đúng như một quy tắc về pinning. Tài liệu và checklist phải luôn ghi rõ phiên bản JDK.
</Callout>

## ThreadLocal, ScopedValue và context request

`ThreadLocal` vẫn hoạt động trên virtual thread. Không cần xoá nó chỉ để chạy Loom. Nhưng virtual threads rất nhiều và mỗi VT có lifecycle ngắn, nên context per-thread phải được dùng có chủ đích.

Ví dụ `ThreadLocal` hợp với state mutable cục bộ của thread, nhưng dễ gây khó đọc vì dependency bị ẩn:

```java
static final ThreadLocal<String> TRACE_ID = new ThreadLocal<>();

void handle(Request request) {
    TRACE_ID.set(request.traceId());
    try {
        service.process(request);
    } finally {
        TRACE_ID.remove(); // bắt buộc khi lifecycle không tự kết thúc ngay
    }
}
```

Với context **bất biến**, truyền từ request xuống các hàm con, `ScopedValue` rõ ràng hơn. `ScopedValue` là API chính thức từ **JDK 25**:

```java
static final ScopedValue<RequestContext> REQUEST_CONTEXT = ScopedValue.newInstance();

void handle(Request request) {
    var context = new RequestContext(request.traceId(), request.userId());

    ScopedValue.where(REQUEST_CONTEXT, context).run(() -> {
        service.process(request);
    });
}

void audit() {
    String traceId = REQUEST_CONTEXT.get().traceId();
    logger.info("traceId={}", traceId);
}
```

`ScopedValue` không phải bản thay thế 1:1 cho mọi `ThreadLocal`:

| Nhu cầu | Phù hợp hơn |
|---|---|
| Context bất biến trong một request/task scope | `ScopedValue` (JDK 25+) hoặc tham số tường minh |
| State mutable riêng của một task | Local variable/đối tượng state truyền tường minh |
| Thư viện cũ yêu cầu `ThreadLocal` | Giữ `ThreadLocal`, audit memory và cleanup |
| Cache/object reuse toàn cục | Cân nhắc cache/pool chuyên dụng, không lạm dụng thread-local |

Trên JDK 21–24, `ScopedValue` còn là preview và cần `--enable-preview`; không nên đưa API preview vào core production mà không chấp nhận chi phí upgrade giữa các JDK.

## Structured Concurrency: dùng khi một request tách thành nhiều subtask

Virtual threads làm việc tạo task rẻ. Structured Concurrency giải quyết vòng đời của các task liên quan: task cha tạo task con, đợi chúng, truyền lỗi/cancellation và không để task con chạy “mồ côi” sau khi scope cha kết thúc.

Ví dụ nghiệp vụ: một request dashboard cần gọi user service và order service song song. Nếu user service fail, thường không có lý do để order service tiếp tục chạy.

```text
handleDashboard request
├── fetchUser
└── fetchOrders

Nếu request cha timeout/cancel hoặc một subtask fail:
→ các subtask cùng scope phải được cancel và được join trước khi cha rời scope.
```

`StructuredTaskScope` là **preview API**. JDK 21 dùng constructor và `ShutdownOnFailure`; JDK 25 đã đổi sang factory `StructuredTaskScope.open(...)` và joiner. Vì API preview không ổn định, chỉ copy code đúng với JDK đang chạy và bật preview ở compile lẫn runtime.

Ví dụ cho **JDK 25**:

```java
// Compile + run với --enable-preview trên JDK 25.
Response handle(String id) throws InterruptedException {
    try (var scope = StructuredTaskScope.open()) {
        Subtask<User> user = scope.fork(() -> userClient.get(id));
        Subtask<List<Order>> orders = scope.fork(() -> orderClient.findByUser(id));

        scope.join(); // mặc định: fail nếu một subtask fail
        return new Response(user.get(), orders.get());
    }
}
```

Nếu team chưa dùng preview API, vẫn dùng được virtual thread executor. Khi đó cần thiết kế rõ timeout, cancellation và cleanup của các `Future`; đừng cho rằng virtual threads tự xử lý quan hệ cha-con.

## Migration từ thread pool sang Virtual Threads

Migration tốt không phải là thay mọi `newFixedThreadPool` thành virtual thread factory. Trước hết cần nhận diện **pool đó đang đại diện cho điều gì**: OS-thread scarcity, giới hạn CPU, giới hạn DB, hay queue/rejection policy.

### Những migration an toàn nhất

Các candidate tốt:

1. Web/API service xử lý request đồng bộ và gọi I/O blocking.
2. Client gọi nhiều HTTP/JDBC/Redis request đồng thời.
3. Consumer có nhiều message độc lập và phần lớn thời gian chờ I/O.
4. Scheduled task fan-out I/O, với concurrency downstream đã được giới hạn riêng.

Quy trình tối thiểu:

1. Nâng lên JDK 21+; nếu có thể ưu tiên JDK 24+ để không còn monitor pinning.
2. Chọn một endpoint I/O-heavy, không đổi toàn hệ thống cùng lúc.
3. Đổi executor thành `newVirtualThreadPerTaskExecutor()` hoặc bật support của framework.
4. Tách giới hạn DB/API/rate limit khỏi thread pool bằng semaphore, pool hoặc gateway rule.
5. Đặt timeout và cancellation cho outbound call.
6. Load test với concurrency cao hơn mức thread pool cũ.
7. Quan sát JFR, connection pool, file descriptor, heap, queue latency và error rate.

### Những thứ không nên đổi máy móc

| Mẫu cũ | Có nên đổi trực tiếp? | Cách suy nghĩ đúng |
|---|---|---|
| `newFixedThreadPool(cpuCount)` để xử lý CPU | **Không** | Đây là CPU concurrency limit hợp lý; giữ/tune nó. |
| Pool 30 threads để bảo vệ DB | **Không trực tiếp** | Giữ giới hạn 30 dưới dạng DB pool/semaphore/bulkhead, sau đó mới dùng VT cho request. |
| `CompletableFuture`/Reactive chỉ để tránh blocking servlet thread | Có thể cân nhắc | Đoạn code blocking tuần tự trên VT thường dễ đọc hơn. |
| Reactive streaming đã có backpressure | Chưa chắc | VT không thay thế demand propagation. |
| Code gọi JNI/native SDK | Cần kiểm tra | Benchmark và xem JFR pinned event trước khi rollout. |
| `ThreadLocal` context | Không cần bỏ ngay | Phân loại immutable/mutable, kiểm tra propagation và memory. |

### Spring Boot

Với Spring Boot 3.2+ và JDK 21+, có thể bật virtual threads:

```properties
spring.threads.virtual.enabled=true
```

Đây là điểm bắt đầu thuận tiện cho MVC/servlet style request handling. Nó không tự tăng DB connection pool, không tạo rate limiter, không sửa timeout và không làm JDBC query nhanh hơn. Sau khi bật, các bottleneck thường lộ ra ở database connection pool, downstream API hoặc queue thay vì servlet thread pool.

## Quan sát và chẩn đoán production

Virtual thread có stack trace và debugger support như thread thường. Tuy nhiên, đừng chỉ nhìn số thread: một JVM có nhiều VT chờ I/O là bình thường. Hãy đo latency, throughput, heap, queue time, connection pool và downstream saturation.

### JFR events

JFR có các event hữu ích:

| Event | Ý nghĩa |
|---|---|
| `jdk.VirtualThreadPinned` | VT bị pin quá ngưỡng; cần xem stack trace và dependency liên quan. |
| `jdk.VirtualThreadSubmitFailed` | JVM không thể start/unpark VT, thường báo áp lực tài nguyên. |
| `jdk.VirtualThreadStart` / `jdk.VirtualThreadEnd` | Quan sát lifecycle; thường phải enable riêng vì tạo nhiều event. |

In các event từ một recording:

```bash
jfr print \
  --events jdk.VirtualThreadPinned,jdk.VirtualThreadSubmitFailed \
  recording.jfr
```

JDK 21–23 cũng có thể bật log pinning khi phát triển:

```bash
java -Djdk.tracePinnedThreads=full -jar application.jar
```

Trên JDK 24+, flag này vẫn có thể giúp phát hiện pinning native, nhưng sẽ không còn báo monitor pinning như JDK cũ.

### Thread dump

Dùng `jcmd` để lấy dump có virtual threads:

```bash
jcmd <PID> Thread.dump_to_file -format=text threads.txt
jcmd <PID> Thread.dump_to_file -format=json threads.json
```

Khi điều tra sự cố, trả lời các câu hỏi theo thứ tự:

1. Request đang chờ đâu: DB, HTTP, lock hay queue?
2. Có bao nhiêu connection/socket/permit đang bị giữ?
3. Có pinned event hoặc native stack nào không?
4. Có CPU saturation/GC pressure không?
5. Timeout/retry có tạo retry storm không?

## Anti-patterns thường gặp

| Anti-pattern | Vì sao có vấn đề | Thay bằng |
|---|---|---|
| Dùng `newFixedThreadPool(100, Thread.ofVirtual().factory())` cho mọi việc | Vẫn giới hạn số task 100 mà không thể hiện lý do business/resource. | Một VT/task; giới hạn riêng DB/API/CPU. |
| “VT rẻ nên nhận vô hạn request” | Heap, queue latency, file descriptors và downstream vẫn hữu hạn. | Admission control, bounded queue, rate limit, bulkhead. |
| Dùng VT cho CPU loop dài | Chiếm carrier, không tăng số core. | CPU executor có parallelism giới hạn. |
| Đổi hết `synchronized` thành `ReentrantLock` trên JDK 24+ | Tăng độ phức tạp mà không còn giải quyết monitor pinning. | Giữ `synchronized` nếu đủ; tránh I/O khi giữ lock vì contention. |
| Giữ lock trong lúc gọi DB/HTTP | Task khác bị chờ lock, state bị giữ lâu. | Tách I/O ra ngoài critical section; thiết kế state/transaction rõ ràng. |
| Đặt ThreadLocal mutable khắp code | Dependency ẩn; bộ nhớ tăng theo số VT sống; khó propagate đúng. | Tham số tường minh hoặc `ScopedValue` cho context bất biến. |
| Nuốt `InterruptedException` | Cancellation/shutdown không hoạt động đúng. | Propagate hoặc restore interrupt rồi thoát. |
| Bỏ Reactive stack chỉ vì “VT là end of reactive” | Mất backpressure/streaming semantics cần thiết. | Chỉ migrate nơi reactive dùng để né blocking thread. |

## Checklist trước khi rollout

- [ ] Runtime là JDK 21+; biết rõ JDK 21–23 khác JDK 24+ ở monitor pinning.
- [ ] Workload mục tiêu là I/O-bound và có nhu cầu concurrency thực tế.
- [ ] CPU-heavy task được tách sang executor có parallelism giới hạn.
- [ ] DB pool, HTTP client pool, rate limit và file descriptor limit đã được kiểm tra.
- [ ] Có timeout, retry budget và cancellation cho outbound call.
- [ ] Concurrency limit được biểu diễn bằng semaphore/bulkhead/admission control, không chỉ bằng size của thread pool.
- [ ] `ThreadLocal`, JNI/native dependency và library cũ đã được audit.
- [ ] Đã load test ở mức concurrency cao hơn cấu hình platform thread cũ.
- [ ] JFR dashboard/recording có `jdk.VirtualThreadPinned` và `jdk.VirtualThreadSubmitFailed`.
- [ ] Có metric cho heap, GC, queue time, connection pool saturation, downstream latency và error rate.

## Cheat sheet

```text
Virtual Thread = cheap thread for a concurrent task, especially one waiting for I/O.

Dùng VT khi:       request/task I/O-bound, code blocking tuần tự.
Không kỳ vọng:     CPU nhanh hơn, DB nhanh hơn, hết rate limit, hết memory limit.
Không pool VT:     tạo một VT cho mỗi task.
Phải giới hạn:     DB/API/CPU/incoming requests bằng cơ chế phù hợp.
JDK 21–23:         synchronized + blocking I/O có thể pin carrier.
JDK 24+:            synchronized không còn gây monitor pinning.
Mọi JDK:            native/foreign call cần quan sát vì vẫn có thể pin.
JDK 25:             ScopedValue chính thức cho context bất biến có scope.
Structured scope:   hữu ích cho fan-out; hiện vẫn là preview API.
```

<Callout type="idea" title="Một câu để nhớ">
  Virtual Threads cho phép viết code blocking, tuần tự và dễ debug ở quy mô concurrency lớn. Chúng thay thế nhu cầu pool OS thread cho I/O, không thay thế việc thiết kế giới hạn tài nguyên và kiểm soát tải.
</Callout>

## Tham khảo

- [JEP 444 — Virtual Threads](https://openjdk.org/jeps/444)
- [Oracle JDK 25 — Virtual Threads](https://docs.oracle.com/en/java/javase/25/core/virtual-threads.html)
- [JEP 491 — Synchronize Virtual Threads without Pinning](https://openjdk.org/jeps/491)
- [JEP 506 — Scoped Values](https://openjdk.org/jeps/506)
- [JEP 505 — Structured Concurrency (Fifth Preview)](https://openjdk.org/jeps/505)
