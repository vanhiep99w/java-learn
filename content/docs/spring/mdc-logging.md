---
title: "MDC trong Spring: Correlation ID, ThreadLocal và Async Logging"
description: "Hiểu MDC của SLF4J/Logback, cách gắn correlation ID trong Spring MVC, propagation qua async/executor/WebFlux, dọn ThreadLocal đúng cách và tránh rò rỉ dữ liệu trong log production."
---

**MDC** (Mapped Diagnostic Context) là map metadata gắn với luồng thực thi hiện tại. Logging framework đọc map này khi ghi log để tự động thêm field như `traceId`, `requestId`, `tenantId` hoặc `userId` vào mọi log line, thay vì truyền các giá trị đó qua từng lời gọi logger.

> [!IMPORTANT]
> MDC thường dựa trên `ThreadLocal`. Nó rất tiện cho request đồng bộ, nhưng **không tự đi qua thread khác**. Mọi ứng dụng dùng `@Async`, `CompletableFuture`, executor, message listener hoặc WebFlux phải thiết kế propagation và cleanup rõ ràng.

## Mục lục

- [1. MDC giải quyết vấn đề gì?](#1-mdc-giải-quyết-vấn-đề-gì)
- [2. MDC hoạt động thế nào?](#2-mdc-hoạt-động-thế-nào)
  - [2.1. API cốt lõi](#21-api-cốt-lõi)
  - [2.2. Vì sao ThreadLocal vừa hữu ích vừa nguy hiểm](#22-vì-sao-threadlocal-vừa-hữu-ích-vừa-nguy-hiểm)
- [3. Thiết kế log context: field nào nên có?](#3-thiết-kế-log-context-field-nào-nên-có)
- [4. Cấu hình Logback để in MDC](#4-cấu-hình-logback-để-in-mdc)
- [5. Gắn correlation ID bằng Servlet Filter](#5-gắn-correlation-id-bằng-servlet-filter)
- [6. MDC và HandlerInterceptor: dùng khi nào?](#6-mdc-và-handlerinterceptor-dùng-khi-nào)
- [7. Propagate MDC qua @Async và Executor](#7-propagate-mdc-qua-async-và-executor)
  - [7.1. TaskDecorator](#71-taskdecorator)
  - [7.2. CompletableFuture và executor đúng](#72-completablefuture-và-executor-đúng)
  - [7.3. Message consumer và scheduler](#73-message-consumer-và-scheduler)
- [8. MDC với Spring Security](#8-mdc-với-spring-security)
- [9. MDC trong WebFlux và Reactor Context](#9-mdc-trong-webflux-và-reactor-context)
- [10. MDC, tracing và OpenTelemetry](#10-mdc-tracing-và-opentelemetry)
- [11. Testing MDC](#11-testing-mdc)
- [12. Anti-patterns và bảo mật log](#12-anti-patterns-và-bảo-mật-log)
- [13. Checklist production](#13-checklist-production)
- [14. Tóm tắt](#14-tóm-tắt)

---

## 1. MDC giải quyết vấn đề gì?

Một request đi qua controller, service, repository và HTTP client thường tạo nhiều log line. Khi nhiều request chạy đồng thời, log xen kẽ nhau. Nếu không có ID chung, việc ghép log thành một câu chuyện hoàn chỉnh rất tốn thời gian.

```text
Không có MDC:
INFO  OrderService - Creating order 42
INFO  PaymentClient - Calling payment provider
WARN  InventoryService - Stock is low
INFO  PaymentClient - Payment accepted

→ Dòng nào thuộc cùng request? Không biết.
```

Với MDC:

```text
INFO  [requestId=67f2... traceId=ab12...] OrderService - Creating order 42
INFO  [requestId=67f2... traceId=ab12...] PaymentClient - Calling payment provider
WARN  [requestId=901c... traceId=cd34...] InventoryService - Stock is low
INFO  [requestId=67f2... traceId=ab12...] PaymentClient - Payment accepted
```

`requestId` liên kết log trong **một request tại service hiện tại**. `traceId` thường liên kết một distributed trace qua **nhiều service**. Hai field có mục đích khác nhau và có thể cùng tồn tại.

## 2. MDC hoạt động thế nào?

MDC là API của SLF4J. Backend như Logback hoặc Log4j2 đọc dữ liệu MDC khi format event log.

### 2.1. API cốt lõi

```java
import org.slf4j.MDC;

MDC.put("requestId", "67f2c9");
MDC.put("tenantId", "acme");

log.info("Creating order");

String requestId = MDC.get("requestId");
Map<String, String> copy = MDC.getCopyOfContextMap();

MDC.remove("tenantId");
MDC.clear();
```

Dùng `MDC.putCloseable()` để scope một field ngắn trong block code:

```java
try (MDC.MDCCloseable ignored = MDC.putCloseable("orderId", orderId.toString())) {
    log.info("Charging payment");
} // orderId tự được remove tại đây
```

Đừng dùng `putCloseable()` thay cho cleanup context cấp request. Context request có nhiều field và có thể đi qua nhiều method. Cấp request nên được quản lý bởi filter với `finally`.

### 2.2. Vì sao ThreadLocal vừa hữu ích vừa nguy hiểm

Với adapter MDC phổ biến của Logback, mỗi thread có context map riêng. Điều này phù hợp Servlet request đồng bộ: một request xử lý chủ yếu trên một Tomcat worker thread.

```text
Tomcat worker-17:
  MDC = { requestId=67f2, tenantId=acme }
  └── Controller → Service → Repository cùng thấy context này

Tomcat worker-21:
  MDC = { requestId=901c, tenantId=globex }
  └── context hoàn toàn khác
```

Nhưng thread trong server là **thread pool**: khi request kết thúc, worker thread không biến mất mà được tái sử dụng. Nếu không clear MDC, request sau có thể thừa hưởng context cũ.

```text
Request A trên worker-17: MDC.put("tenantId", "acme")
Request A xong nhưng quên clear
Request B tái sử dụng worker-17
→ log Request B vẫn có tenantId=acme  ❌
```

> [!WARNING]
> Rò rỉ MDC không chỉ làm log sai. Nếu `tenantId`, `userId` hoặc thông tin nhạy cảm xuất hiện trong log của request khác, nó tạo ra sự cố điều tra/audit và có thể là sự cố bảo mật.

## 3. Thiết kế log context: field nào nên có?

Context tốt phải trả lời nhanh: “log này thuộc request, trace, tenant và tác nhân nào?” Nhưng không nên biến MDC thành nơi chứa toàn bộ request.

| Field | Giá trị ví dụ | Khi nào nên dùng |
|---|---|---|
| `requestId` | `a2c8d8e1-...` | Mọi inbound request; liên kết log trong service |
| `traceId` | `4bf92f3577...` | Distributed tracing; thường do tracing library cung cấp |
| `spanId` | `00f067aa...` | Phân biệt operation trong một trace |
| `tenantId` | `acme` | Multi-tenant app, sau khi đã validate tenant |
| `userId` | `usr_123` | Audit/debug; dùng ID nội bộ, không dùng email nếu không cần |
| `orderId` | `ord_456` | Scope ngắn cho business operation cụ thể |
| `jobId` | `job_789` | Batch, scheduler, message processing |

Không đặt vào MDC:

- password, API key, access token, refresh token, session ID;
- toàn bộ JWT claims hoặc toàn bộ request header/body;
- email, số điện thoại, địa chỉ, số thẻ nếu không có policy retention và masking rõ ràng;
- object lớn hoặc dữ liệu có cardinality/quy mô không giới hạn.

Tên key nên nhất quán, lowercase camelCase hoặc snake_case theo chuẩn log platform. Đừng dùng cả `request-id`, `request_id`, `requestId` trong cùng hệ thống.

## 4. Cấu hình Logback để in MDC

Với Spring Boot + Logback, tạo `src/main/resources/logback-spring.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
    <include resource="org/springframework/boot/logging/logback/defaults.xml"/>

    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} %-5level [req:%X{requestId:-} trace:%X{traceId:-} tenant:%X{tenantId:-}] %logger{36} - %msg%n</pattern>
        </encoder>
    </appender>

    <root level="INFO">
        <appender-ref ref="CONSOLE"/>
    </root>
</configuration>
```

`%X{requestId:-}` đọc key `requestId` từ MDC. `:-` là fallback rỗng nếu key chưa tồn tại. Một log line sẽ có dạng:

```text
10:31:49.117 INFO  [req:67f2c9 trace:4bf92f tenant:acme] c.example.OrderService - Creating order
```

Nhiều log platform ưu tiên JSON thay vì pattern text. Khi đó MDC field nên được xuất thành JSON field độc lập để Elasticsearch, Loki, Datadog hoặc Cloud Logging có thể query/index:

```json
{
  "timestamp": "2026-03-31T10:31:49.117Z",
  "level": "INFO",
  "logger": "com.example.OrderService",
  "message": "Creating order",
  "requestId": "67f2c9",
  "traceId": "4bf92f",
  "tenantId": "acme"
}
```

> [!TIP]
> Nếu production dùng structured JSON log, đừng parse text log sau này để trích `requestId`. Xuất MDC thành field có cấu trúc ngay từ đầu.

## 5. Gắn correlation ID bằng Servlet Filter

Correlation ID cần tồn tại từ đầu request, bao gồm Spring Security, request bị reject trước controller và error handling. Vì vậy `OncePerRequestFilter` là điểm đặt phù hợp hơn HandlerInterceptor.

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class CorrelationIdFilter extends OncePerRequestFilter {
    private static final String HEADER = "X-Request-Id";
    private static final String MDC_KEY = "requestId";

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {

        String requestId = resolveRequestId(request);
        response.setHeader(HEADER, requestId);

        MDC.put(MDC_KEY, requestId);
        try {
            filterChain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }

    private String resolveRequestId(HttpServletRequest request) {
        String incoming = request.getHeader(HEADER);

        // Không tin tưởng giá trị header từ client một cách vô điều kiện.
        if (incoming != null && incoming.matches("[A-Za-z0-9-]{16,128}")) {
            return incoming;
        }
        return UUID.randomUUID().toString();
    }
}
```

Filter làm bốn việc:

1. Lấy ID từ header inbound nếu format hợp lệ, hoặc sinh UUID mới.
2. Đặt ID vào MDC để log downstream tự có field này.
3. Echo ID trong response header để client/support team đối chiếu.
4. Xoá MDC trong `finally`, kể cả khi controller/filter sau ném exception.

Không nên tin `X-Request-Id` từ Internet như một identity/security credential. Nó chỉ là correlation metadata. Với public-facing service, validate độ dài/charset để tránh log injection hoặc cardinality bất thường; với untrusted request, bạn cũng có thể luôn sinh ID server-side và chỉ log client-provided ID ở một field riêng đã sanitize.

### Thứ tự filter

Correlation filter nên chạy rất sớm để log của security filter và MVC pipeline đã có request ID. Tuy nhiên order chính xác phải xem toàn bộ application. Nếu dùng tracing library, thư viện đó có thể đã tạo trace context trước đó.

```text
Ví dụ thứ tự:
1. Tracing/observation context filter
2. CorrelationIdFilter
3. Spring Security DelegatingFilterProxy
4. Request logging / MVC DispatcherServlet
```

Chi tiết về Servlet filter order và DispatcherServlet ở các bài liên quan bên dưới.

## 6. MDC và HandlerInterceptor: dùng khi nào?

Filter phù hợp cho context cấp toàn bộ request. `HandlerInterceptor` phù hợp khi context chỉ biết được sau khi Spring MVC đã chọn handler, ví dụ endpoint name hoặc annotation business.

```java
@Component
public class EndpointMdcInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(
            HttpServletRequest request,
            HttpServletResponse response,
            Object handler) {

        if (handler instanceof HandlerMethod method) {
            String endpoint = method.getBeanType().getSimpleName()
                + "#" + method.getMethod().getName();
            MDC.put("endpoint", endpoint);
        }
        return true;
    }

    @Override
    public void afterCompletion(
            HttpServletRequest request,
            HttpServletResponse response,
            Object handler,
            Exception ex) {
        MDC.remove("endpoint");
    }
}
```

Đăng ký explicit:

```java
@Configuration
class MvcConfig implements WebMvcConfigurer {
    private final EndpointMdcInterceptor interceptor;

    MvcConfig(EndpointMdcInterceptor interceptor) {
        this.interceptor = interceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(interceptor)
            .addPathPatterns("/api/**")
            .order(100);
    }
}
```

Hạn chế của interceptor:

- Không tạo MDC cho log trước `DispatcherServlet`, gồm một phần Spring Security.
- Không chắc chạy cho static resources hoặc request không tìm được MVC handler.
- Với async MVC, cần xử lý lifecycle thêm qua `AsyncHandlerInterceptor`.

Vì vậy mô hình phổ biến là: **Filter tạo `requestId`/trace context; interceptor thêm `endpoint` hoặc metadata chỉ có sau mapping**.

## 7. Propagate MDC qua @Async và Executor

### 7.1. TaskDecorator

`@Async` chuyển công việc sang `TaskExecutor`. Worker thread có MDC riêng, nên nó không tự thấy map của request thread.

`TaskDecorator` chụp context tại lúc submit, set context trước khi chạy task và khôi phục context cũ trong `finally`:

```java
public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable task) {
        Map<String, String> callerContext = MDC.getCopyOfContextMap();

        return () -> {
            Map<String, String> workerPreviousContext = MDC.getCopyOfContextMap();
            try {
                if (callerContext == null || callerContext.isEmpty()) {
                    MDC.clear();
                } else {
                    MDC.setContextMap(callerContext);
                }
                task.run();
            } finally {
                if (workerPreviousContext == null || workerPreviousContext.isEmpty()) {
                    MDC.clear();
                } else {
                    MDC.setContextMap(workerPreviousContext);
                }
            }
        };
    }
}
```

Cấu hình executor riêng:

```java
@Configuration
@EnableAsync
class AsyncConfig {

    @Bean(name = "applicationTaskExecutor")
    TaskExecutor applicationTaskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(8);
        executor.setMaxPoolSize(32);
        executor.setQueueCapacity(500);
        executor.setThreadNamePrefix("app-async-");
        executor.setTaskDecorator(new MdcTaskDecorator());
        executor.initialize();
        return executor;
    }
}
```

```java
@Service
class InvoiceService {

    @Async("applicationTaskExecutor")
    public CompletableFuture<Void> generateInvoice(Long orderId) {
        log.info("Generating invoice for order={}", orderId);
        return CompletableFuture.completedFuture(null);
    }
}
```

`MdcTaskDecorator` phải khôi phục **previous worker context**, không chỉ gọi `MDC.clear()`. Worker có thể đang chạy trong một context hợp lệ do wrapper bên ngoài, nhất là khi executor/wrapper bị lồng.

### 7.2. CompletableFuture và executor đúng

Đây là lỗi phổ biến:

```java
CompletableFuture.runAsync(() -> log.info("Running export"));
// Dùng ForkJoinPool.commonPool() mặc định → không đi qua TaskDecorator của app
```

Truyền executor đã decorate:

```java
@Service
class ExportService {
    private final Executor applicationTaskExecutor;

    ExportService(@Qualifier("applicationTaskExecutor") Executor applicationTaskExecutor) {
        this.applicationTaskExecutor = applicationTaskExecutor;
    }

    CompletableFuture<Void> export() {
        return CompletableFuture.runAsync(
            () -> log.info("Running export"),
            applicationTaskExecutor
        );
    }
}
```

Một cách khác là wrap runnable rõ ràng bằng utility, nhưng đó dễ bị quên. Chuẩn hoá một executor có `TaskDecorator` và cấm common pool trong application code thường bền vững hơn.

### 7.3. Message consumer và scheduler

Kafka/RabbitMQ listener, scheduled task và batch job không có HTTP request thread. Chúng vẫn cần log context, nhưng ID phải xuất phát từ message/job chứ không phải MDC rỗng hoặc request ID cũ.

```java
@KafkaListener(topics = "order-created")
public void onOrderCreated(OrderCreatedEvent event,
                           @Header(name = "X-Request-Id", required = false) String requestId) {
    String id = isValid(requestId) ? requestId : UUID.randomUUID().toString();

    try (MDC.MDCCloseable request = MDC.putCloseable("requestId", id);
         MDC.MDCCloseable order = MDC.putCloseable("orderId", event.orderId().toString())) {
        log.info("Processing order-created event");
        service.process(event);
    }
}
```

Mỗi message phải set/clear context độc lập vì listener container cũng tái sử dụng consumer thread. Với scheduled job, sinh `jobId` cho từng lần chạy và clear sau run.

> [!IMPORTANT]
> Propagate correlation metadata qua message header là một phần của event contract. MDC chỉ giúp logging cục bộ; nó không tự truyền header qua Kafka, RabbitMQ, HTTP client hoặc database outbox.

## 8. MDC với Spring Security

Sau khi Spring Security authenticate thành công, application có thể thêm `userId` hoặc `tenantId` vào MDC. Nhưng cần hiểu thứ tự:

```text
CorrelationIdFilter
  → Spring Security authentication filters
    → DispatcherServlet / controller
```

Correlation ID nên do filter chạy sớm tạo. User identity chỉ nên thêm **sau khi** security context hợp lệ. Có ba cách thường gặp:

| Cách | Khi phù hợp | Trade-off |
|---|---|---|
| Filter đặt sau authentication filter | Cần user field cho mọi log sau Security | Phải kiểm soát chính xác filter order |
| `HandlerInterceptor` | Chỉ cần ở MVC controller/service flow | Không phủ log trong security filters |
| Logging từ business operation với `putCloseable` | User ID chỉ cần cho một operation | Không tự phủ toàn request |

Ví dụ interceptor đọc principal đã xác thực:

```java
@Override
public boolean preHandle(
        HttpServletRequest request,
        HttpServletResponse response,
        Object handler) {

    Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
    if (authentication != null && authentication.isAuthenticated()
            && !(authentication instanceof AnonymousAuthenticationToken)) {
        AppUser user = (AppUser) authentication.getPrincipal();
        MDC.put("userId", user.id().toString());
    }
    return true;
}
```

Không log `authentication.getCredentials()`, raw JWT hoặc entire principal object. Principal có thể chứa email, authorities, token metadata hoặc fields không được phép ghi log.

Với `@Async`, MDC propagation và SecurityContext propagation là **hai việc khác nhau**. `MdcTaskDecorator` chỉ copy MDC. Nếu background task cần current authenticated user để authorize, dùng `DelegatingSecurityContextAsyncTaskExecutor` hoặc, tốt hơn, truyền identity/business actor rõ ràng theo thiết kế nghiệp vụ.

## 9. MDC trong WebFlux và Reactor Context

WebFlux là reactive stack. Một request có thể chạy trên nhiều thread; `ThreadLocal` MDC không giữ đúng context xuyên suốt pipeline. Không dùng Servlet `Filter` hoặc `HandlerInterceptor` cho Reactor Netty app.

Dùng `WebFilter` để đặt ID vào Reactor `Context`:

```java
@Component
class CorrelationWebFilter implements WebFilter {

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String requestId = UUID.randomUUID().toString();
        exchange.getResponse().getHeaders().set("X-Request-Id", requestId);

        return chain.filter(exchange)
            .contextWrite(context -> context.put("requestId", requestId));
    }
}
```

Đọc context trong reactive chain:

```java
Mono.deferContextual(context -> {
    String requestId = context.getOrDefault("requestId", "-");
    log.info("Processing reactive requestId={}", requestId);
    return service.process();
});
```

Để MDC tự xuất hiện trong mọi log reactive, cần bridge Reactor Context ↔ MDC tại mỗi signal hoặc dùng integration observability của framework/library. Không đơn giản là `MDC.put()` một lần ở đầu request, vì operator sau có thể chạy ở thread khác.

```text
Servlet MVC: ThreadLocal MDC thường hợp lệ trong request đồng bộ.
WebFlux:     Reactor Context là source of truth; MDC chỉ là projection tạm thời lúc log.
```

> [!WARNING]
> `InheritableThreadLocal` không khắc phục Reactor. Nó chỉ copy value khi tạo child thread; reactive scheduler có thể chuyển/reuse thread bất kỳ lúc nào.

## 10. MDC, tracing và OpenTelemetry

MDC correlation ID là logging context; distributed tracing là mô hình quan sát đầy đủ hơn với trace, span, timing và propagation protocol.

```text
HTTP request
  traceId=4bf92f...    ← cùng trên nhiều service
  spanId=a1b2...       ← operation ở gateway
      │
      ├── HTTP call → service B, spanId=c3d4...
      └── Kafka event → consumer spanId=e5f6...
```

Khi có Micrometer Tracing/OpenTelemetry, library thường:

1. Đọc `traceparent`/B3 header inbound.
2. Tạo hoặc tiếp tục trace/span.
3. Inject tracing headers vào outbound HTTP/message.
4. Đưa `traceId` và `spanId` vào logging context theo integration đã cấu hình.

Vì vậy không nên tự sinh một `traceId` khác trong filter nếu tracing system đã là source of truth. Bạn vẫn có thể giữ `requestId` local để support team tra cứu request cụ thể.

| Nhu cầu | Ưu tiên |
|---|---|
| Ghép log trong một service | MDC `requestId` |
| Theo dõi request qua nhiều service | OpenTelemetry/Micrometer trace context |
| Xem latency của từng dependency | Span và metrics |
| Điều tra business operation | MDC scope field như `orderId`, `tenantId` đã được kiểm soát |

> [!TIP]
> Hãy để tracing framework chịu trách nhiệm `traceId`/`spanId`. Application code chỉ thêm business identifiers có chủ đích vào MDC, và không ghi dữ liệu nhạy cảm.

## 11. Testing MDC

Test filter để đảm bảo response echo ID và context được dọn sau request. Không nên assert format log text nếu có thể assert MDC/property trực tiếp.

```java
@WebMvcTest(OrderController.class)
@Import(CorrelationIdFilter.class)
class CorrelationIdFilterTest {

    @Autowired
    MockMvc mockMvc;

    @Test
    void echoesValidRequestId() throws Exception {
        mockMvc.perform(get("/api/orders/42")
                .header("X-Request-Id", "request-id-123456"))
            .andExpect(status().isOk())
            .andExpect(header().string("X-Request-Id", "request-id-123456"));
    }

    @AfterEach
    void cleanMdc() {
        MDC.clear(); // test isolation, kể cả khi test lỗi trước filter finally
    }
}
```

Test `TaskDecorator` theo hai điều kiện:

1. Task thấy snapshot context của caller tại lúc submit.
2. Sau task, worker context cũ được khôi phục hoặc context được clear.

```java
@Test
void propagatesAndCleansMdc() {
    MdcTaskDecorator decorator = new MdcTaskDecorator();
    MDC.put("requestId", "req-1");

    AtomicReference<String> seen = new AtomicReference<>();
    Runnable wrapped = decorator.decorate(() -> seen.set(MDC.get("requestId")));

    MDC.clear();
    wrapped.run();

    assertThat(seen.get()).isEqualTo("req-1");
    assertThat(MDC.get("requestId")).isNull();
}
```

Với integration test async, chờ `CompletableFuture` hoàn tất trước assertion để tránh test kết thúc khi worker vẫn còn chạy.

## 12. Anti-patterns và bảo mật log

| Anti-pattern | Vấn đề | Cách sửa |
|---|---|---|
| `MDC.put()` không có `finally`/close | Context rò sang request/task sau trên pooled thread | Dùng filter `try/finally` hoặc `MDCCloseable` |
| Dùng `CompletableFuture.runAsync()` không truyền executor | Chạy common pool, không có TaskDecorator | Truyền executor đã decorate |
| Copy MDC nhưng không restore worker context | Phá context hợp lệ của wrapper/task ngoài | Save previous context, restore trong `finally` |
| Dùng MDC làm nơi lưu business state | Code phụ thuộc hidden global state; async dễ fail | Truyền state qua parameter/domain context rõ ràng |
| Ghi raw JWT/API key vào MDC | Mọi log downstream có thể lộ secret | Chỉ log ID/claim đã allowlist và sanitize |
| Tin `X-Request-Id` bất kỳ từ public client | Log injection, giá trị quá dài, index cardinality xấu | Validate/sanitize hoặc sinh server-side ID |
| Cho tenant/user input tự do vào indexed field | Tăng storage/query cost, có thể gây log forging | Giới hạn length/charset, canonicalize ID |
| Dùng MDC ThreadLocal trong WebFlux | Context biến mất/sai khi đổi thread | Dùng Reactor Context + observability bridge |
| Thay `traceId` của tracing library bằng UUID riêng | Trace/log không còn liên kết | Để tracing framework sở hữu trace/span IDs |

### Log masking và retention

MDC không làm dữ liệu an toàn hơn; nó chỉ làm dữ liệu xuất hiện trong **nhiều log line hơn**. Trước khi thêm field, xác định:

- field có phải PII, secret hoặc regulated data không;
- ai có quyền đọc log;
- log được giữ bao lâu và ở đâu;
- field có cần hash, redact hoặc truncate không;
- index field có tăng chi phí/độ nhạy cảm vận hành không.

Ví dụ nếu cần liên kết theo email nhưng không cần đọc email, log hash có salt do hệ thống quản lý thay vì email raw. Trong nhiều trường hợp, `userId` nội bộ là đủ.

## 13. Checklist production

- [ ] Mọi inbound request có `requestId` sinh/validate tại filter rất sớm.
- [ ] Response echo request ID để client và support đối chiếu.
- [ ] MDC được clear trong `finally` trên mọi filter/listener/job boundary.
- [ ] Async executor chuẩn có `TaskDecorator` để propagate và restore MDC.
- [ ] `CompletableFuture` không dùng common pool vô tình.
- [ ] Kafka/RabbitMQ headers mang correlation/trace metadata theo contract.
- [ ] Scheduler/batch job tạo `jobId` mới mỗi lần chạy.
- [ ] `traceId`/`spanId` do tracing integration quản lý, không tự nhân bản.
- [ ] WebFlux dùng Reactor Context, không dựa vào `ThreadLocal` MDC lâu dài.
- [ ] MDC schema được documented: key, source, sensitivity, retention.
- [ ] Không có token/password/body/PII không cần thiết trong MDC.
- [ ] Tests kiểm tra propagation và cleanup ở async path.

## 14. Tóm tắt

```text
MDC = metadata logging gắn với execution context hiện tại.

Spring MVC đồng bộ:
  Filter → MDC.put(requestId) → Controller/Service logs → finally MDC.clear()

Async/executor:
  Caller MDC snapshot → TaskDecorator → worker MDC → finally restore/clear

Messaging:
  Header/event metadata → set MDC cho từng message → finally clear

WebFlux:
  Reactor Context là source of truth; MDC chỉ là projection lúc ghi log.
```

| Thành phần | Trách nhiệm |
|---|---|
| `MDC` | Lưu key/value logging context tại execution scope |
| `OncePerRequestFilter` | Tạo/validate request ID và cleanup cho Servlet request |
| `HandlerInterceptor` | Bổ sung metadata chỉ biết sau controller mapping |
| `TaskDecorator` | Propagate/restore MDC trên executor worker thread |
| Tracing library | Quản lý trace/span và propagation qua service boundary |
| Reactor Context | Context đúng cho reactive pipeline |

> [!TIP]
> Quy tắc cốt lõi: **set MDC ở boundary, clear ở `finally`, propagate có chủ đích qua async, và chỉ log identifiers được phép.** MDC tốt giúp điều tra nhanh; MDC không được quản lý sẽ tạo log sai và rò rỉ context.

<Cards>
  <Card title="Filter và Interceptor" href="/docs/spring/filter-va-interceptor" description="Đặt correlation filter và endpoint interceptor ở đúng tầng request pipeline." />
  <Card title="DispatcherServlet" href="/docs/spring/dispatcher-servlet" description="Hiểu Filter, interceptor và MVC controller chạy theo thứ tự nào." />
  <Card title="Spring Security" href="/docs/spring/spring-security" description="Xem SecurityContext ThreadLocal và propagation trong async." />
</Cards>
