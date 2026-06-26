---
title: "Vì sao @Transactional không rollback khi gọi method trong cùng class? — Deep Dive"
description: "Câu hỏi phỏng vấn Spring kinh điển: đặt @Transactional lên method nhưng nó không rollback, không mở transaction. Thủ phạm là self-invocation và cơ chế proxy của Spring AOP. Mổ xẻ proxy JDK vs CGLIB, vì sao gọi this.method() bỏ qua proxy, và 6 cách sửa đúng."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)](#2-câu-trả-lời-30-giây-nếu-phỏng-vấn-hỏi-nhanh)
- [3. Tái hiện bug — rollback không xảy ra](#3-tái-hiện-bug--rollback-không-xảy-ra)
- [4. Hiểu lầm cốt lõi: "annotation tự nó làm phép"](#4-hiểu-lầm-cốt-lõi-annotation-tự-nó-làm-phép)
- [5. Spring AOP hoạt động bằng proxy — không phải bytecode weaving](#5-spring-aop-hoạt-động-bằng-proxy--không-phải-bytecode-weaving)
- [6. Vì sao this.method() bỏ qua proxy](#6-vì-sao-thismethod-bỏ-qua-proxy)
- [7. JDK dynamic proxy vs CGLIB](#7-jdk-dynamic-proxy-vs-cglib)
- [8. Các thủ phạm "anh em" cùng gốc proxy](#8-các-thủ-phạm-anh-em-cùng-gốc-proxy)
- [9. Sáu cách sửa đúng](#9-sáu-cách-sửa-đúng)
- [10. Cách chứng minh trong 2 phút](#10-cách-chứng-minh-trong-2-phút)
- [11. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp](#11-câu-hỏi-đào-sâu-mà-người-phỏng-vấn-sẽ-hỏi-tiếp)
- [12. Tóm tắt — Cheat sheet & 3 nguyên tắc](#12-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi có một method `@Transactional`. Khi controller gọi thẳng nó thì rollback hoạt động ngon. Nhưng khi tôi gọi nó **từ một method khác trong cùng class** (kiểu `this.saveData()`), thì `@Transactional` **không có tác dụng** — không mở transaction, exception ném ra mà dữ liệu vẫn được commit, không rollback. Annotation vẫn nằm đó, không sai chính tả. Tại sao? Và sửa thế nào?"*

Đây là câu hỏi tách biệt **người chỉ biết "gắn `@Transactional` là xong"** với **người hiểu Spring làm điều đó bằng cách nào**. Người mới sẽ nghi *"annotation bị lỗi"* hoặc *"thiếu cấu hình"*. Người hiểu sâu sẽ hỏi ngược lại ngay: **"Cú gọi đó có đi qua proxy của Spring không? Vì `@Transactional` chỉ chạy khi lời gọi đi qua proxy — mà `this.method()` thì không."**

> [!IMPORTANT]
> Mấu chốt: `@Transactional` (và phần lớn annotation của Spring như `@Async`, `@Cacheable`, `@Retryable`) **không tự nó làm gì cả**. Nó chỉ là chỉ dẫn để Spring tạo một **proxy** bọc quanh bean của bạn. Logic transaction nằm trong **proxy**, không nằm trong object thật. Khi bạn gọi `this.method()`, bạn gọi thẳng object thật, **bỏ qua proxy** → không có ai mở/commit/rollback transaction. Hiện tượng này gọi là **self-invocation**.

---

## 2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)

> Spring hiện thực `@Transactional` bằng **AOP proxy**: lúc khởi động, Spring không inject object thật của bạn mà inject một **proxy** bọc quanh nó. Proxy chặn lời gọi *từ bên ngoài*, mở transaction trước và commit/rollback sau. Nhưng khi một method trong bean gọi method khác **của chính nó** qua `this` (self-invocation), lời gọi đó đi **thẳng tới object thật**, không qua proxy → advice transaction **không chạy**.
>
> Sửa phổ biến nhất: **tách method `@Transactional` sang một bean (class) khác** và inject vào, để lời gọi đi qua proxy. Hoặc tự inject proxy của chính mình (self-injection), hoặc dùng `AopContext.currentProxy()`, hoặc chuyển sang `TransactionTemplate` lập trình tay. Bản chất là: **phải để lời gọi đi qua proxy.**

Phần còn lại của doc giải thích **proxy hoạt động thế nào** và **vì sao `this` lại thoát khỏi nó** — kiến thức nền cho hàng loạt bug Spring khác.

---

## 3. Tái hiện bug — rollback không xảy ra

```java
@Service
public class OrderService {

    @Autowired
    private OrderRepository repo;

    // Method công khai, KHÔNG có @Transactional
    public void processOrder(Order order) {
        // ... vài bước chuẩn bị ...
        this.saveWithTransaction(order);   // ❌ gọi qua this → bỏ qua proxy
    }

    @Transactional   // ← annotation NẰM ĐÂY, nhưng vô tác dụng khi bị gọi từ this
    public void saveWithTransaction(Order order) {
        repo.save(order.getHeader());      // ghi 1
        if (order.isInvalid()) {
            throw new RuntimeException("dữ liệu sai");  // mong đợi rollback ghi 1
        }
        repo.save(order.getDetails());     // ghi 2
    }
}
```

Khi controller gọi `orderService.processOrder(...)`, và bên trong nó gọi `this.saveWithTransaction(...)`:

| Cách gọi | `@Transactional` chạy? | Khi exception | Vì sao |
|----------|:----------------------:|---------------|--------|
| Controller → `processOrder` → `this.saveWithTransaction` | ❌ Không | **Không rollback** (ghi 1 đã commit) | `this` bỏ qua proxy |
| Controller → `orderService.saveWithTransaction` (gọi trực tiếp) | ✅ Có | Rollback đúng | Đi qua proxy |

Hành vi "ma quái" thường gặp:
- Đặt `@Transactional` lên `processOrder` (method bên ngoài) thì lại chạy → càng làm người ta tưởng "lúc được lúc không".
- Log không hề báo lỗi; chỉ phát hiện khi dữ liệu "nửa vời" lọt vào DB.

> [!WARNING]
> Bug này **âm thầm** — không có exception, không có warning. Spring không thể (và không) cảnh báo rằng "`@Transactional` của bạn đang bị bỏ qua do self-invocation". Bạn chỉ phát hiện khi rollback không xảy ra và DB còn lại dữ liệu rác. Đó là lý do nó là câu hỏi phỏng vấn ưa thích.

---

## 4. Hiểu lầm cốt lõi: "annotation tự nó làm phép"

Mô hình sai trong đầu nhiều người:

```diagram
❌ Mô hình sai:
   @Transactional  ──(bằng phép thuật)──►  method tự biết mở/commit transaction
        "Cứ gắn vào là nó tự lo, ở đâu cũng được."
```

Thực tế, annotation chỉ là **metadata** — một mẩu thông tin dán lên method. Bản thân nó **không chứa code**. Phải có ai đó **đọc** annotation và **sinh ra hành vi**. Trong Spring, "ai đó" là cơ chế AOP, và hành vi được nhét vào một **proxy**:

```diagram
✅ Mô hình đúng:
   Lúc startup:
     Spring quét thấy @Transactional → tạo PROXY bọc quanh OrderService
     Logic "mở tx → gọi method thật → commit/rollback" nằm trong PROXY

   Lúc chạy:
     caller ──► PROXY (mở tx) ──► object thật (method) ──► PROXY (commit/rollback)
                  ▲
            chỉ chạy khi lời gọi ĐI QUA đây
```

Annotation là "tấm biển chỉ dẫn"; proxy là "người thực thi". Tấm biển dán đúng chỗ nhưng nếu lời gọi không đi ngang qua người thực thi thì chẳng ai làm gì cả.

> [!NOTE]
> Đây là nguyên lý chung của **Spring AOP declarative**: `@Transactional`, `@Async`, `@Cacheable`, `@Retryable`, `@PreAuthorize`... tất cả đều dựa vào proxy. Hiểu một cái là hiểu hết — và self-invocation phá tất cả chúng theo cùng một cách.

---

## 5. Spring AOP hoạt động bằng proxy — không phải bytecode weaving

Có hai trường phái làm AOP, và Spring chọn **proxy-based** (khác với AspectJ dùng **weaving**):

```diagram
AspectJ (compile-time / load-time WEAVING):
   Sửa thẳng bytecode của class → logic AOP nhúng VÀO chính method
   → this.method() cũng bị chặn (vì code đã ở trong method rồi)
   → KHÔNG bị self-invocation, nhưng cần weaver/agent riêng

Spring AOP (runtime PROXY):
   Không đụng bytecode của bạn → tạo một object BAO BÊN NGOÀI
   → chỉ chặn được lời gọi ĐI QUA proxy
   → this.method() KHÔNG đi qua proxy → bị bỏ qua  ← thủ phạm
```

Lúc context khởi động, một `BeanPostProcessor` (vd `InfrastructureAdvisorAutoProxyCreator`) phát hiện bean có `@Transactional`, và thay vì đăng ký object gốc, nó đăng ký một **proxy**:

```diagram
Bean trong Spring container thực chất là:

   ┌──────────────────── OrderService$$Proxy ────────────────────┐
   │  saveWithTransaction(order) {                               │
   │     txManager.begin();           ← advice TRƯỚC             │
   │     try {                                                   │
   │        target.saveWithTransaction(order);  ← object THẬT    │
   │        txManager.commit();                                  │
   │     } catch (RuntimeException e) {                          │
   │        txManager.rollback();     ← advice SAU (lỗi)         │
   │     }                                                       │
   │  }                                                          │
   └────────────────────────────────────────────────────────────┘
                          │ ủy quyền tới
                          ▼
              ┌──── OrderService (target thật) ────┐
              │  saveWithTransaction(order) {      │
              │     repo.save(...);                │  ← KHÔNG biết gì về tx
              │  }                                 │
              └────────────────────────────────────┘
```

Mọi thứ inject vào nơi khác (`@Autowired OrderService`) thực chất là **proxy**, không phải target. Đó là lý do gọi từ ngoài thì transaction chạy.

---

## 6. Vì sao this.method() bỏ qua proxy

Đây là trái tim của câu trả lời. Bên trong object thật, từ khóa `this` trỏ tới **chính object thật đó** — **không phải** proxy. Proxy chỉ là một object *khác* bọc bên ngoài; object thật **không hề biết** proxy tồn tại.

```diagram
caller bên ngoài:
   proxy.processOrder()
      └─► target.processOrder()        ← đang chạy TRONG target
              └─► this.saveWithTransaction()
                     │
                     ▼
                  this = TARGET (object thật), KHÔNG phải proxy!
                  → gọi thẳng target.saveWithTransaction()
                  → KHÔNG đi qua lớp advice của proxy
                  → không begin/commit/rollback → @Transactional vô hiệu
```

```diagram
So sánh hai đường đi:

  ✅ Đi qua proxy (có tx):
     caller ──► [PROXY: begin tx] ──► target.method ──► [PROXY: commit]

  ❌ Self-invocation (không tx):
     caller ──► [PROXY] ──► target.outer() ──► this.inner()
                                                  └─► target.inner()  (proxy bị nhảy cóc)
```

> [!IMPORTANT]
> Một câu để chốt trong phỏng vấn: **"`this` là object thật, không phải proxy. Advice của Spring sống trong proxy. Lời gọi nội bộ qua `this` không bao giờ chạm proxy, nên không có advice nào được áp dụng."** Đây là lý do gốc rễ, áp dụng cho mọi annotation proxy-based.

---

## 7. JDK dynamic proxy vs CGLIB

Spring tạo proxy bằng một trong hai cơ chế — chi tiết này hay được hỏi nối tiếp:

| | JDK Dynamic Proxy | CGLIB |
|--|-------------------|-------|
| Cách tạo | Implement **interface** của bean | Tạo **subclass** kế thừa bean |
| Điều kiện | Bean phải có interface | Class không `final`, method không `final`/`private` |
| Khi nào Spring dùng | Bean có interface (mặc định cũ) | Không có interface; Spring Boot **mặc định CGLIB** |
| Hệ quả | Chỉ proxy được method khai báo trong interface | Proxy được method `public`/`protected` |

```diagram
JDK proxy:   interface OrderService
                    ▲ implements
             OrderServiceImpl (target)
             OrderService$Proxy (implements interface, ủy quyền tới target)

CGLIB proxy: OrderService (target, class thường)
                    ▲ extends
             OrderService$$EnhancerBySpringCGLIB (subclass, override method để chèn advice)
```

Điểm chung quan trọng: **cả hai đều bị self-invocation.** Dù là JDK hay CGLIB, lời gọi `this.method()` từ bên trong target đều đi thẳng tới target, không qua lớp proxy.

> [!NOTE]
> Hệ quả thực tế của CGLIB (subclass): `@Transactional` **không hoạt động** trên method `private`, `final`, hay `static` — vì subclass không override được chúng. Tương tự, đặt `@Transactional` trên method không `public` thường bị bỏ qua. Đây là một biến thể khác của "annotation có đó mà không chạy".

---

## 8. Các thủ phạm "anh em" cùng gốc proxy

Vì cùng dựa trên proxy, hàng loạt annotation Spring "chết" theo cùng kiểu self-invocation. Nhận ra một, nhận ra tất cả:

| Annotation | Triệu chứng khi bị self-invocation |
|------------|------------------------------------|
| `@Transactional` | Không mở tx, không rollback |
| `@Async` | Chạy **đồng bộ** trên thread gọi, không sang thread pool |
| `@Cacheable` / `@CachePut` | Không đọc/ghi cache, luôn chạy method thật |
| `@Retryable` | Không retry khi lỗi |
| `@PreAuthorize` / `@Secured` | Không kiểm tra quyền |
| `@Validated` (method-level) | Không validate tham số |

```java
@Service
public class ReportService {
    public void run() {
        this.generate();   // ❌ @Async bị bỏ qua → chạy ĐỒNG BỘ, không async
    }
    @Async
    public void generate() { /* tác vụ nặng */ }
}
```

> [!TIP]
> Trong phỏng vấn, nếu bạn nói được "đây là cùng một gốc rễ với `@Async` không chạy, `@Cacheable` không cache" thì rất ghi điểm — cho thấy bạn hiểu **cơ chế** chứ không học thuộc từng case. Xem thêm bài chuyên sâu về `@Async`/`@Cacheable` trong cùng category này.

---

## 9. Sáu cách sửa đúng

Bản chất mọi cách sửa là: **làm cho lời gọi đi qua proxy** (hoặc bỏ proxy mà dùng cơ chế khác).

### 9.1. Tách sang bean khác (khuyến nghị nhất)

```java
@Service
public class OrderService {
    @Autowired private OrderTxService txService;   // bean KHÁC

    public void processOrder(Order order) {
        txService.saveWithTransaction(order);   // ✅ gọi qua proxy của bean khác
    }
}

@Service
public class OrderTxService {
    @Transactional
    public void saveWithTransaction(Order order) { ... }
}
```

Lời gọi giờ đi từ bean này sang bean khác → bắt buộc đi qua proxy của `OrderTxService`. Đây là cách **sạch nhất** và còn giúp tách trách nhiệm.

### 9.2. Self-injection (inject chính proxy của mình)

```java
@Service
public class OrderService {
    @Autowired private OrderService self;   // Spring inject PROXY của chính nó

    public void processOrder(Order order) {
        self.saveWithTransaction(order);    // ✅ gọi qua proxy
    }
    @Transactional
    public void saveWithTransaction(Order order) { ... }
}
```

Hoạt động vì `self` là proxy. (Spring xử lý được circular reference kiểu này; nếu báo lỗi vòng lặp, dùng `@Lazy` trên field.)

### 9.3. `AopContext.currentProxy()`

```java
@EnableAspectJAutoProxy(exposeProxy = true)   // bắt buộc bật cờ này
// ...
public void processOrder(Order order) {
    ((OrderService) AopContext.currentProxy()).saveWithTransaction(order);  // ✅
}
```

Lấy proxy hiện tại từ thread-local. Cần `exposeProxy = true`. Hơi "magic", nên thường ưu tiên cách 9.1.

### 9.4. `TransactionTemplate` — lập trình tay (không dùng proxy)

```java
@Autowired private TransactionTemplate txTemplate;

public void processOrder(Order order) {
    txTemplate.execute(status -> {       // ✅ tự quản lý tx, không phụ thuộc proxy
        repo.save(order.getHeader());
        if (order.isInvalid()) status.setRollbackOnly();
        repo.save(order.getDetails());
        return null;
    });
}
```

Kiểm soát rõ ràng, không dính bẫy proxy. Tốt khi logic transaction phức tạp hoặc nằm sâu trong một method.

### 9.5. Chuyển sang AspectJ weaving

Dùng `@EnableTransactionManagement(mode = AdviceMode.ASPECTJ)` + load-time/compile-time weaving. Vì AspectJ sửa bytecode trực tiếp, `this.method()` cũng bị chặn → hết self-invocation. Đổi lại phải cấu hình weaver/agent — ít dùng trong dự án thường.

### 9.6. Đặt `@Transactional` ở đúng tầng (entry point)

Thường thì nên đặt `@Transactional` ở **method công khai là điểm vào** (vd method service được controller gọi), thay vì method nội bộ. Nếu `processOrder` là entry point, đặt `@Transactional` lên chính nó là xong.

| Cách | Khi nào chọn |
|------|--------------|
| 9.1 Tách bean | Mặc định, sạch nhất |
| 9.2 Self-injection | Không muốn tạo class mới |
| 9.3 `AopContext` | Hiếm, khi không tách được |
| 9.4 `TransactionTemplate` | Cần kiểm soát tx thủ công/phức tạp |
| 9.5 AspectJ | Dự án đã dùng weaving |
| 9.6 Đặt đúng tầng | Khi entry point rõ ràng |

> [!IMPORTANT]
> 90% trường hợp chọn **9.1 (tách bean)** hoặc **9.6 (đặt `@Transactional` ở entry point)**. Hai cách còn lại (`AopContext`, self-injection) là "thuốc cấp cứu" khi không tái cấu trúc được.

---

## 10. Cách chứng minh trong 2 phút

Để khẳng định bug đúng là self-invocation chứ không phải nguyên nhân khác:

```java
// Bật log để thấy transaction có mở hay không:
// application.properties
logging.level.org.springframework.transaction.interceptor=TRACE
logging.level.org.springframework.orm.jpa.JpaTransactionManager=DEBUG
```

```diagram
B1. Gọi method trực tiếp từ ngoài (controller/test) → xem log có "Getting transaction" không.
    • CÓ log mở tx + rollback hoạt động → proxy ổn, annotation ổn.

B2. Gọi qua self-invocation (this.method) → xem lại log.
    • KHÔNG còn log "Getting transaction" → xác nhận self-invocation.

B3. In ra class của bean: System.out.println(orderService.getClass());
    • Thấy "...$$EnhancerBySpringCGLIB..." hoặc "$Proxy" → bean LÀ proxy (đúng kỳ vọng).
    • Bên trong target, this.getClass() KHÔNG có hậu tố proxy → đó là target thật.
```

> [!TIP]
> Mẹo nhanh nhất: bật `logging.level.org.springframework.transaction.interceptor=TRACE`. Nếu khi gọi nội bộ mà **không thấy** dòng "Getting transaction for [...]" thì advice không chạy → chắc chắn self-invocation (hoặc method non-public).

---

## 11. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp

> **"Vì sao đặt `@Transactional` trên method `private` cũng không chạy?"**
Proxy CGLIB hoạt động bằng cách **subclass + override** method. Method `private` (và `final`, `static`) không thể override → proxy không chèn advice được. Spring chỉ proxy được method `public` (và `protected` với CGLIB). Đây là cùng họ vấn đề với self-invocation.

> **"AspectJ khác Spring AOP ở điểm nào mà không bị self-invocation?"**
AspectJ dùng **weaving** — sửa thẳng bytecode của class, nhúng advice vào *chính method*. Nên dù gọi qua `this`, advice vẫn nằm trong method đó. Spring AOP dùng **proxy bao ngoài** nên `this` thoát được. Đổi lại AspectJ cần weaver/agent.

> **"Self-injection có gây circular dependency không?"**
Có nguy cơ, nhưng Spring xử lý được bean tự tham chiếu trong nhiều trường hợp; nếu lỗi, thêm `@Lazy` để phá vòng. Tuy vậy nhiều người coi self-injection là "code smell" và ưu tiên tách bean.

> **"Mặc định Spring Boot dùng proxy nào?"**
CGLIB (subclass-based), kể cả khi bean có interface — từ Spring Boot 2.x trở đi `spring.aop.proxy-target-class=true` là mặc định. Có thể đổi về JDK proxy nếu cần.

> **"`@Transactional` trên method gọi method khác cùng tx thì sao (propagation)?"**
Khi cả hai đi qua proxy, hành vi do `propagation` quyết định: mặc định `REQUIRED` → method trong join vào tx đang có. Nhưng nếu gọi nội bộ qua `this`, ngay cả propagation cũng vô nghĩa vì advice không chạy.

> **"Rollback chỉ xảy ra với loại exception nào?"**
Mặc định Spring rollback với **unchecked exception** (`RuntimeException`/`Error`), **không** rollback với **checked exception**. Muốn rollback checked exception phải khai báo `@Transactional(rollbackFor = Exception.class)`. (Đây là một bẫy "không rollback" khác, không liên quan proxy — đáng nhắc để phân biệt.)

---

## 12. Tóm tắt — Cheat sheet & 3 nguyên tắc

**Cheat sheet — "`@Transactional` không chạy":**

| Triệu chứng | Nguyên nhân | Fix |
|-------------|-------------|-----|
| Gọi `this.method()` nội bộ, không rollback | Self-invocation — bỏ qua proxy | Tách bean / self-inject / `AopContext` |
| `@Transactional` trên method `private`/`final` | CGLIB không override được | Đổi sang `public`, không `final` |
| Gọi trực tiếp thì chạy, nội bộ thì không | Khẳng định self-invocation | Đưa lời gọi qua proxy |
| Checked exception ném ra vẫn commit | Mặc định chỉ rollback unchecked | `rollbackFor = Exception.class` |
| `@Async`/`@Cacheable` cũng "im lặng" | Cùng gốc proxy + self-invocation | Cùng cách sửa |

**Ba nguyên tắc để không bao giờ dính lại:**

1. **Annotation Spring không tự làm gì — proxy mới làm.** `@Transactional`/`@Async`/`@Cacheable` chỉ là metadata; logic nằm trong proxy bọc ngoài bean.
2. **Lời gọi phải đi QUA proxy.** Self-invocation (`this.method()`) gọi thẳng target → bỏ qua advice. Method phải `public` (CGLIB không proxy được `private`/`final`).
3. **Sửa = đưa lời gọi qua proxy.** Tách sang bean khác (ưu tiên), self-injection, `AopContext.currentProxy()`, hoặc bỏ proxy mà dùng `TransactionTemplate`.

> [!IMPORTANT]
> Câu trả lời ghi điểm trọn vẹn gồm: **(1)** Spring làm `@Transactional` bằng **AOP proxy**, không phải annotation tự thân; **(2)** `this.method()` là **self-invocation** gọi thẳng target nên bỏ qua proxy; **(3)** cùng cơ chế này phá luôn `@Async`/`@Cacheable`/`@Retryable`; **(4)** cách sửa chuẩn là **tách bean** (hoặc đặt `@Transactional` ở entry point).
