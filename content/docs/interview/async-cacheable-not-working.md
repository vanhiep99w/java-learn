---
title: "Vì sao @Async chạy đồng bộ và @Cacheable không cache?"
description: "Câu hỏi phỏng vấn Spring: gắn @Async mà method vẫn chạy trên thread gọi (đồng bộ), gắn @Cacheable mà method vẫn chạy mỗi lần (không cache). Mổ xẻ gốc rễ proxy + self-invocation, quên @EnableAsync/@EnableCaching, dùng sai kiểu trả về, và cách sửa từng case."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)](#2-câu-trả-lời-30-giây-nếu-phỏng-vấn-hỏi-nhanh)
- [3. Tái hiện bug — async không async, cache không cache](#3-tái-hiện-bug--async-không-async-cache-không-cache)
- [4. Gốc rễ chung: cùng một cơ chế proxy](#4-gốc-rễ-chung-cùng-một-cơ-chế-proxy)
- [5. Nguyên nhân #1: self-invocation](#5-nguyên-nhân-1-self-invocation)
- [6. Nguyên nhân #2: quên @EnableAsync / @EnableCaching](#6-nguyên-nhân-2-quên-enableasync--enablecaching)
- [7. Nguyên nhân #3: method không public / final / private](#7-nguyên-nhân-3-method-không-public--final--private)
- [8. Bẫy riêng của @Async](#8-bẫy-riêng-của-async)
- [9. Bẫy riêng của @Cacheable](#9-bẫy-riêng-của-cacheable)
- [10. Checklist chẩn đoán](#10-checklist-chẩn-đoán)
- [11. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp](#11-câu-hỏi-đào-sâu-mà-người-phỏng-vấn-sẽ-hỏi-tiếp)
- [12. Tóm tắt — Cheat sheet & 3 nguyên tắc](#12-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi gắn `@Async` lên một method để nó chạy nền, nhưng nó vẫn **chạy đồng bộ** trên thread của caller — không hề sang thread pool. Tương tự, tôi gắn `@Cacheable` để cache kết quả, nhưng method vẫn **chạy mỗi lần được gọi**, cache như không tồn tại. Annotation gõ đúng, không sai chính tả. Tại sao? Và sửa thế nào?"*

Đây là câu hỏi kiểm tra xem ứng viên có hiểu **cơ chế đằng sau annotation của Spring** hay chỉ "gắn vào cho có". Người mới sẽ nghĩ *"annotation lỗi"* hoặc *"thiếu thư viện"*. Người hiểu sâu nhận ra ngay: **`@Async` và `@Cacheable` cùng dựa trên AOP proxy như `@Transactional`, nên chúng "chết" theo cùng những nguyên nhân — đứng đầu là self-invocation và quên bật annotation kích hoạt.**

> [!IMPORTANT]
> Mấu chốt: `@Async`, `@Cacheable`, `@Transactional`, `@Retryable` là **anh em cùng cha** — đều là declarative AOP, đều hoạt động qua **proxy** bọc quanh bean. Hiểu một cái là hiểu cả họ. Khi một annotation proxy-based "im lặng không làm gì", hãy nghĩ ngay tới 3 nghi phạm: **(1) self-invocation**, **(2) quên bật `@EnableXxx`**, **(3) method không proxy được (private/final/non-public)**.

---

## 2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)

> Cả hai dựa trên **AOP proxy**: hành vi async (đẩy việc sang thread pool) và caching (kiểm tra cache trước khi chạy) nằm trong **proxy** bọc quanh bean, không nằm trong object thật. Nên chúng thất bại khi:
> 1. **Self-invocation** — gọi `this.method()` trong cùng class → bỏ qua proxy.
> 2. **Quên `@EnableAsync` / `@EnableCaching`** — không bật thì Spring không tạo proxy tương ứng, annotation bị **bỏ qua hoàn toàn** (không cảnh báo).
> 3. **Method không proxy được** — `private`, `final`, hoặc non-public với CGLIB.
>
> Ngoài ra `@Async` còn bẫy riêng: kiểu trả về phải là `void`/`Future`/`CompletableFuture` (trả `T` thường thì caller không nhận được kết quả async), và cần cấu hình executor. `@Cacheable` bẫy riêng: key sinh sai, cache thực ra trúng nhưng bạn tưởng không, hoặc gọi nội bộ.

Phần còn lại của doc đi sâu từng nguyên nhân và bẫy riêng của mỗi annotation.

---

## 3. Tái hiện bug — async không async, cache không cache

```java
@Service
public class ReportService {

    // Caller mong "generate" chạy nền, nhưng nó chạy đồng bộ:
    public void handleRequest() {
        this.generateAsync();          // ❌ self-invocation → @Async bị bỏ qua
        System.out.println("xong");    // dòng này KHÔNG in trước generateAsync như mong đợi
    }

    @Async
    public void generateAsync() {
        // tác vụ nặng 5 giây — đáng lẽ chạy ở thread khác
    }

    // Cache như không tồn tại:
    public Product lookup(Long id) {
        return this.getProduct(id);    // ❌ self-invocation → @Cacheable bị bỏ qua
    }

    @Cacheable("products")
    public Product getProduct(Long id) {
        // luôn chạy query DB, dù id lặp lại
        return repo.findById(id).orElseThrow();
    }
}
```

| Annotation | Triệu chứng | Nghi phạm hàng đầu |
|------------|-------------|--------------------|
| `@Async` | Chạy đồng bộ trên thread caller; `handleRequest` bị block 5s | Self-invocation hoặc quên `@EnableAsync` |
| `@Cacheable` | Query DB mọi lần, cache rỗng | Self-invocation hoặc quên `@EnableCaching` |

> [!WARNING]
> Cả hai bug đều **âm thầm**: không exception, không warning. `@Async` "thất bại" trông y hệt code chạy bình thường (chỉ là chậm/đồng bộ). `@Cacheable` "thất bại" trông y hệt cache miss liên tục. Bạn chỉ phát hiện khi đo hiệu năng hoặc đếm số query.

---

## 4. Gốc rễ chung: cùng một cơ chế proxy

Giống `@Transactional`, lúc startup Spring tạo proxy bọc quanh bean và nhét logic vào đó:

```text
@Async:
   ┌──── ReportService$$Proxy ─────────────────────┐
   │  generateAsync() {                            │
   │     taskExecutor.submit(() ->                 │  ← đẩy sang thread pool
   │         target.generateAsync());              │
   │     return;   // trả ngay cho caller          │
   │  }                                            │
   └───────────────────────────────────────────────┘

@Cacheable:
   ┌──── ReportService$$Proxy ─────────────────────┐
   │  getProduct(id) {                             │
   │     if (cache.contains(id))                   │  ← kiểm tra cache TRƯỚC
   │         return cache.get(id);                 │
   │     T result = target.getProduct(id);         │
   │     cache.put(id, result);                    │  ← lưu cache SAU
   │     return result;                            │
   │  }                                            │
   └───────────────────────────────────────────────┘
```

Vì logic nằm trong proxy, **mọi nguyên nhân khiến lời gọi không đi qua proxy đều phá cả hai**. Đó là lý do ta xét chung. (Xem bài "@Transactional self-invocation" trong cùng category để hiểu sâu cơ chế proxy + CGLIB/JDK.)

> [!NOTE]
> Khác biệt nhỏ: `@Transactional` được bật mặc định trong Spring Boot (qua auto-config), nhưng `@Async` và `@Cacheable` **phải tự bật** bằng `@EnableAsync` / `@EnableCaching`. Đây là lý do "quên bật" là nghi phạm số 1 *riêng* cho hai annotation này, mà `@Transactional` ít gặp.

---

## 5. Nguyên nhân #1: self-invocation

Hệt như `@Transactional`: gọi `this.method()` từ bên trong cùng class đi thẳng tới object thật, bỏ qua proxy.

```text
caller ──► proxy.handleRequest()
              └─► target.handleRequest()
                     └─► this.generateAsync()
                            │
                            ▼
                         this = TARGET, không phải proxy
                         → gọi thẳng target.generateAsync() (đồng bộ, không cache)
```

**Cách sửa** (giống `@Transactional`):

```java
// ✅ Tách sang bean khác
@Service
public class ReportService {
    @Autowired private AsyncWorker worker;
    public void handleRequest() {
        worker.generateAsync();   // đi qua proxy của AsyncWorker
    }
}
@Service
public class AsyncWorker {
    @Async
    public void generateAsync() { ... }
}
```

Hoặc self-injection (`@Autowired ReportService self;` rồi gọi `self.generateAsync()`), hoặc `AopContext.currentProxy()`. Cách ưu tiên vẫn là **tách bean**.

---

## 6. Nguyên nhân #2: quên @EnableAsync / @EnableCaching

Đây là nghi phạm **đặc trưng** của hai annotation này. Khác `@Transactional` (Spring Boot bật sẵn), `@Async` và `@Cacheable` **không làm gì** nếu bạn chưa bật cơ chế tương ứng:

```java
@SpringBootApplication
@EnableAsync       // ✅ bắt buộc để @Async hoạt động
@EnableCaching     // ✅ bắt buộc để @Cacheable hoạt động
public class Application { ... }
```

```text
Không có @EnableAsync:
   Spring KHÔNG đăng ký AsyncAnnotationBeanPostProcessor
   → KHÔNG tạo proxy async cho bean có @Async
   → @Async bị coi như không tồn tại → method chạy đồng bộ, IM LẶNG

Không có @EnableCaching:
   Spring KHÔNG đăng ký cache interceptor
   → @Cacheable bị bỏ qua → method chạy mỗi lần
```

> [!WARNING]
> Đây là lỗi phổ biến và dễ bị bỏ sót nhất vì **không có thông báo lỗi**. Annotation gõ đúng, code compile, app chạy — chỉ là tính năng "biến mất". Luôn kiểm tra `@EnableAsync`/`@EnableCaching` (và một `CacheManager` bean) đã có chưa, đây là việc đầu tiên cần làm khi `@Cacheable`/`@Async` không hoạt động.

`@Cacheable` còn cần một **`CacheManager`** bean (vd `ConcurrentMapCacheManager`, Caffeine, Redis...). Thiếu cache provider thì caching cũng không chạy đúng.

---

## 7. Nguyên nhân #3: method không public / final / private

Spring Boot mặc định dùng **CGLIB** (subclass + override). Method không override được thì proxy không chèn được advice:

| Modifier | Proxy được? | Hệ quả |
|----------|:-----------:|--------|
| `public` | ✅ | OK |
| `protected` | ⚠️ (CGLIB được, JDK không) | Tránh để chắc chắn |
| `private` | ❌ | `@Async`/`@Cacheable` bị bỏ qua |
| `final` | ❌ | CGLIB không override được |
| `static` | ❌ | Không phải instance method |

```java
@Async
private void doWork() { ... }   // ❌ private → proxy không chèn được → chạy đồng bộ
```

> [!TIP]
> Quy tắc an toàn: method có annotation AOP **luôn để `public`, không `final`, không `static`**, và được gọi từ **bean khác**. Vi phạm bất kỳ điều nào → annotation có nguy cơ "im lặng".

---

## 8. Bẫy riêng của @Async

Ngoài 3 nguyên nhân chung, `@Async` có những bẫy riêng:

### 8.1. Kiểu trả về sai

```java
@Async
public Product loadProduct() { ... }   // ❌ trả T thường: caller nhận về null/giá trị rác
                                        //    vì proxy trả NGAY trước khi method chạy xong

@Async
public CompletableFuture<Product> loadProduct() {   // ✅ đúng
    return CompletableFuture.completedFuture(...);
}
```

Kiểu trả về hợp lệ cho `@Async`: **`void`**, **`Future<T>`**, **`CompletableFuture<T>`** (hoặc `ListenableFuture`). Trả về `T` thường thì giá trị trả về **vô nghĩa** — caller nhận được giá trị mặc định ngay lập tức.

### 8.2. Thiếu / sai cấu hình Executor

Không khai báo executor riêng thì Spring dùng `SimpleAsyncTaskExecutor` — **tạo thread mới mỗi lần**, không pool, nguy hiểm dưới tải cao. Nên cấu hình:

```java
@Bean
public Executor taskExecutor() {
    ThreadPoolTaskExecutor ex = new ThreadPoolTaskExecutor();
    ex.setCorePoolSize(8);
    ex.setMaxPoolSize(16);
    ex.setQueueCapacity(100);
    ex.initialize();
    return ex;
}
// dùng: @Async("taskExecutor")
```

### 8.3. Exception "biến mất"

Với `@Async void`, exception ném ra **không** quay về caller (vì chạy thread khác). Phải dùng `AsyncUncaughtExceptionHandler` hoặc trả `CompletableFuture` để bắt lỗi. Đây là bẫy hay gây "lỗi nuốt không dấu vết".

> [!NOTE]
> Tổng kết `@Async`: trả `void`/`Future`/`CompletableFuture`, cấu hình `ThreadPoolTaskExecutor` riêng, xử lý exception qua handler. Đừng để `SimpleAsyncTaskExecutor` mặc định lên production.

---

## 9. Bẫy riêng của @Cacheable

### 9.1. Cache key sinh ngoài ý muốn

Mặc định key = tổ hợp tham số. Nhiều tham số / object phức tạp → key không như bạn nghĩ → "miss" liên miên hoặc "trúng nhầm".

```java
@Cacheable(value = "products", key = "#id")          // ✅ chỉ định key rõ ràng
public Product getProduct(Long id, boolean detail) { ... }
```

### 9.2. `@Cacheable` không tự cập nhật/xóa

`@Cacheable` chỉ **đọc-hoặc-chạy-rồi-lưu**. Khi dữ liệu thay đổi, cache cũ vẫn còn (stale). Phải dùng:
- `@CachePut` — luôn chạy method và cập nhật cache (dùng cho update).
- `@CacheEvict` — xóa entry khi dữ liệu bị xóa/sửa.

### 9.3. `null` và `condition`/`unless`

Mặc định Spring **cache cả `null`** (tùy provider). Dùng `unless = "#result == null"` để không cache null, hoặc `condition` để chỉ cache khi thỏa điều kiện.

```java
@Cacheable(value = "products", key = "#id", unless = "#result == null")
public Product getProduct(Long id) { ... }
```

### 9.4. Thiếu `CacheManager` / cache name chưa khai báo

Một số provider yêu cầu khai báo trước tên cache. Thiếu cấu hình → caching im lặng không hoạt động.

> [!TIP]
> Khi nghi `@Cacheable` không cache: bật log `logging.level.org.springframework.cache=TRACE` để thấy "Cache hit"/"Cache miss". Nếu **không thấy log cache nào** → chưa `@EnableCaching` hoặc self-invocation. Nếu thấy **toàn miss** với cùng tham số → vấn đề ở **key**.

---

## 10. Checklist chẩn đoán

```text
╭──────────────────────────────────────────────────────────────╮
│ B1. Đã có @EnableAsync / @EnableCaching chưa?                │
│     • Chưa → thêm vào @Configuration/@SpringBootApplication   │
│     • @Cacheable: có CacheManager bean + cache provider chưa? │
│                                                              │
│ B2. Lời gọi có đi qua proxy không?                           │
│     • Gọi this.method() nội bộ? → self-invocation → tách bean │
│                                                              │
│ B3. Method có public, không final/private/static không?      │
│     • Vi phạm → đổi sang public, bỏ final                    │
│                                                              │
│ B4. (@Async) Kiểu trả về có là void/Future/CompletableFuture?│
│     • Trả T thường → sửa kiểu trả về                         │
│     • Có ThreadPoolTaskExecutor riêng chưa?                  │
│                                                              │
│ B5. (@Cacheable) Bật log cache xem hit/miss:                 │
│     • Không thấy log → B1/B2. Toàn miss → vấn đề KEY (mục 9)  │
╰──────────────────────────────────────────────────────────────╯
```

---

## 11. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp

> **"Vì sao `@Transactional` thường chạy mà `@Async`/`@Cacheable` hay 'quên bật'?"**
Spring Boot auto-config bật transaction management sẵn (khi có `DataSource`), nhưng `@Async`/`@Cacheable` cần bạn chủ động `@EnableAsync`/`@EnableCaching`. Nên "quên bật" là lỗi đặc trưng của hai annotation này.

> **"`@Async` trả `void` thì làm sao biết nó lỗi?"**
Không biết qua return — phải đăng ký `AsyncUncaughtExceptionHandler` (qua `AsyncConfigurer`). Nếu cần kết quả/biết lỗi, dùng `CompletableFuture` và xử lý `.exceptionally(...)`.

> **"`@Cacheable` và `@Transactional` trên cùng method, thứ tự thế nào?"**
Cả hai là advice trên proxy, thứ tự do `@Order`/ưu tiên quyết định. Thường cache interceptor chạy ngoài transaction; cần cẩn thận: cache có thể lưu giá trị trước khi tx commit. Cân nhắc tách rõ ràng.

> **"Tại sao gọi nội bộ phá cả hai theo cùng kiểu?"**
Vì cả hai là proxy-based AOP. `this.method()` không đi qua proxy → advice (async/caching) không chạy. Cùng gốc rễ với `@Transactional`.

> **"Caching tự viết bằng `Map` trong service khác gì `@Cacheable`?"**
`@Cacheable` cho cache khai báo, thống nhất với nhiều provider (Caffeine/Redis), có TTL/eviction/condition. Nhưng nó dính bẫy proxy. Cache thủ công trong method thì không dính self-invocation nhưng phải tự lo TTL/thread-safety/eviction.

---

## 12. Tóm tắt — Cheat sheet & 3 nguyên tắc

**Cheat sheet — "annotation AOP im lặng không chạy":**

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| `@Async` chạy đồng bộ | Quên `@EnableAsync` | Thêm `@EnableAsync` |
| `@Cacheable` luôn query | Quên `@EnableCaching` / thiếu `CacheManager` | Thêm `@EnableCaching` + cache provider |
| Gọi `this.method()` nội bộ | Self-invocation | Tách bean / self-inject |
| Method `private`/`final` | CGLIB không proxy được | Đổi `public`, bỏ `final` |
| `@Async` trả `T`, caller nhận rác | Sai kiểu trả về | Dùng `void`/`CompletableFuture` |
| `@Cacheable` toàn miss | Key sinh sai | Chỉ định `key = "#id"` |
| Cache cũ không cập nhật | `@Cacheable` không evict | Dùng `@CachePut`/`@CacheEvict` |

**Ba nguyên tắc:**

1. **`@Async`/`@Cacheable` là proxy-based AOP — cùng họ với `@Transactional`.** Chúng "chết" theo cùng nguyên nhân: self-invocation, method không proxy được.
2. **Phải BẬT cơ chế: `@EnableAsync` / `@EnableCaching` (+ `CacheManager`).** Khác `@Transactional`, không bật thì annotation bị bỏ qua **âm thầm**.
3. **Mỗi annotation có bẫy riêng.** `@Async`: kiểu trả về + executor + xử lý exception. `@Cacheable`: key + evict + null. Bật log để chẩn đoán hit/miss.

> [!IMPORTANT]
> Câu trả lời ghi điểm trọn vẹn: **(1)** nhận ra cả hai là **proxy-based AOP** cùng gốc với `@Transactional`; **(2)** kiểm tra **`@EnableAsync`/`@EnableCaching`** trước tiên; **(3)** loại trừ **self-invocation** và method **non-public/final**; **(4)** nắm bẫy riêng (kiểu trả về của `@Async`, key/evict của `@Cacheable`).
