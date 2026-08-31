---
title: "@Component, @Service, @Repository khác nhau gì? Có thay thế nhau được không?"
description: "Câu hỏi phỏng vấn Spring: phân biệt các stereotype annotations, exception translation của @Repository và khi nào không nên dùng chúng thay thế nhau."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [3. Điểm chung: đều tạo Spring bean](#3-điểm-chung-đều-tạo-spring-bean)
- [4. Khác biệt của từng annotation](#4-khác-biệt-của-từng-annotation)
  - [@Component](#component)
  - [@Service](#service)
  - [@Repository](#repository)
  - [@Controller và @RestController](#controller-và-restcontroller)
- [5. Có thể thay thế nhau không?](#5-có-thể-thay-thế-nhau-không)
- [6. Ví dụ thực tế](#6-ví-dụ-thực-tế)
- [7. Câu hỏi đào sâu](#7-câu-hỏi-đào-sâu)
- [8. Tóm tắt](#8-tóm-tắt)

---

## 1. Câu hỏi phỏng vấn

> *"What is the difference between `@Component`, `@Service`, `@Repository`, `@Controller`... and can they replace one another?"*
>
> `@Component`, `@Service`, `@Repository` và các annotation liên quan khác nhau thế nào? Chúng có thể dùng thay thế cho nhau không?

Câu hỏi này kiểm tra hai ý: ứng viên có hiểu **component scanning** — cơ chế Spring quét class để tạo bean — hay chỉ biết gắn annotation theo thói quen; và có biết `@Repository` có một hành vi kỹ thuật riêng hay không.

## 2. Câu trả lời 30 giây

`@Service`, `@Repository` và `@Controller` đều là **specialization** (biến thể chuyên biệt) của `@Component`. Vì thế, khi `@ComponentScan` quét package, tất cả đều được đăng ký thành Spring bean và có thể được inject bằng constructor như nhau.

Khác biệt chính là **ý nghĩa kiến trúc**: `@Component` là bean chung; `@Service` dành cho business logic; `@Repository` dành cho tầng truy cập dữ liệu và là điểm đánh dấu để Spring có thể dịch exception của persistence sang hệ exception `DataAccessException`; `@Controller` dành cho tầng web MVC. Về mặt tạo bean, nhiều trường hợp có thể thay nhau. Nhưng không nên thay theo kiểu tùy tiện vì làm sai vai trò của class, khó đọc code, và `@Repository`/`@Controller` có hành vi framework-specific mà `@Component` hoặc `@Service` không tự mang lại.

> [!IMPORTANT]
> Quy tắc thực hành: dùng annotation thể hiện đúng **layer** của class. Không dùng `@Service` cho DAO chỉ vì cả hai đều được Spring scan.

## 3. Điểm chung: đều tạo Spring bean

Các annotation này đều được meta-annotate bằng `@Component` (trực tiếp hoặc gián tiếp). Khi cấu hình component scan quét tới package chứa class, Spring tạo bean cho chúng.

```java
@Service
public class OrderService {
}

@Repository
public class JdbcOrderRepository {
}

@Component
public class OrderNumberGenerator {
}
```

Cả ba class trên đều có thể được inject qua constructor:

```java
@Service
public class CheckoutService {
    private final OrderService orderService;
    private final JdbcOrderRepository orderRepository;

    public CheckoutService(
            OrderService orderService,
            JdbcOrderRepository orderRepository) {
        this.orderService = orderService;
        this.orderRepository = orderRepository;
    }
}
```

`@ComponentScan` không coi `@Service` hay `@Repository` là bean loại khác. Chúng vẫn là Spring bean bình thường với cùng khả năng dùng DI, AOP (`@Transactional`, logging, security) và lifecycle callback.

## 4. Khác biệt của từng annotation

### @Component

`@Component` là stereotype tổng quát nhất. Dùng nó cho class hạ tầng hoặc helper không thuộc rõ web, business hay data layer.

Ví dụ hợp lý: validator, mapper, formatter, scheduler helper hoặc adapter tích hợp dịch vụ bên ngoài.

```java
@Component
public class PasswordStrengthValidator {
    public boolean isStrong(String password) {
        return password.length() >= 12;
    }
}
```

### @Service

`@Service` biểu đạt class chứa **business logic**: điều phối use case, áp dụng rule nghiệp vụ, gọi nhiều repository hoặc service khác, và thường là ranh giới transaction.

```java
@Service
public class OrderService {
    private final OrderRepository orderRepository;

    public OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional
    public void placeOrder(CreateOrderCommand command) {
        // Kiểm tra rule nghiệp vụ, tính giá, rồi lưu order.
        orderRepository.save(Order.create(command));
    }
}
```

Trong Spring Framework cơ bản, `@Service` chủ yếu mang ý nghĩa kiến trúc; nó không tự thêm một cơ chế runtime riêng so với `@Component`.

### @Repository

`@Repository` dành cho lớp truy cập dữ liệu: DAO, implementation tự viết của repository, hoặc adapter làm việc với JPA/JDBC/Redis/Elasticsearch.

Ngoài ý nghĩa kiến trúc, đây là annotation có điểm khác biệt quan trọng: Spring có thể áp dụng **persistence exception translation**. Khi được cấu hình (ví dụ qua `PersistenceExceptionTranslationPostProcessor`), exception đặc thù của provider như JPA/Hibernate có thể được chuyển thành hierarchy nhất quán của Spring là `DataAccessException`.

```java
@Repository
public class JdbcOrderRepository {
    private final JdbcTemplate jdbcTemplate;

    public JdbcOrderRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public Optional<Order> findById(long id) {
        // JdbcTemplate cũng dùng DataAccessException khi có lỗi truy cập DB.
        return Optional.empty();
    }
}
```

> [!NOTE]
> Với Spring Data JPA, interface kế thừa `JpaRepository` thường đã được framework tạo proxy và xử lý exception translation. Bạn không cần gắn `@Repository` lên từng interface Spring Data chỉ để làm nó hoạt động.

### @Controller và @RestController

`@Controller` là stereotype cho Spring MVC: nó đánh dấu class xử lý HTTP request. Kết hợp với `@RequestMapping`, Spring MVC phát hiện các handler method trong class này.

`@RestController` tương đương `@Controller` + `@ResponseBody`: giá trị trả về của handler được ghi thẳng vào HTTP response body, thường dưới dạng JSON.

```java
@RestController
@RequestMapping("/orders")
public class OrderController {
    @GetMapping("/{id}")
    public OrderResponse get(@PathVariable long id) {
        return new OrderResponse(id);
    }
}
```

Đây không phải annotation để thay bằng `@Service`: thay nó sẽ khiến class không còn được Spring MVC nhận diện là controller handler theo cơ chế thông thường.

## 5. Có thể thay thế nhau không?

**Về việc được component scan và tạo bean:** thường là có. Đổi `@Service` thành `@Component`, hoặc đổi `@Repository` thành `@Service`, vẫn tạo được bean nếu package được scan.

**Về thiết kế và hành vi framework:** không nên coi chúng là hoàn toàn thay thế được.

| Thay thế | Có chạy như bean? | Điều cần lưu ý |
|---|:---:|---|
| `@Service` ↔ `@Component` | Thường có | Không mất cơ chế đặc biệt đáng kể, nhưng mất ý nghĩa business layer trong code và tooling. |
| `@Repository` → `@Component`/`@Service` | Có thể | Có thể không còn là điểm áp dụng persistence exception translation; sai trách nhiệm data layer. |
| `@Controller` → `@Service`/`@Component` | Không nên | Có thể không được Spring MVC phát hiện là request handler. |
| `@RestController` → `@Controller` | Có, nhưng khác response | Phải thêm `@ResponseBody` cho từng handler trả JSON/body. |

Vì vậy, câu trả lời phỏng vấn tốt là: **chúng cùng là Spring bean stereotype, nên có phần chồng lấn về cơ chế scan; nhưng hãy dùng đúng annotation theo trách nhiệm, đặc biệt giữ `@Repository` cho persistence exception translation và `@Controller`/`@RestController` cho web layer.**

## 6. Ví dụ thực tế

```text
HTTP request
    │
    ▼
OrderController       @RestController: nhận/trả HTTP, validate input ở biên
    │
    ▼
OrderService          @Service: thực thi use case và business rule
    │
    ▼
OrderRepositoryImpl   @Repository: đọc/ghi database, dịch exception persistence
```

```java
@RestController
@RequestMapping("/orders")
class OrderController {
    private final OrderService orderService;

    OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @PostMapping
    OrderResponse create(@RequestBody CreateOrderRequest request) {
        return orderService.create(request);
    }
}

@Service
class OrderService {
    private final OrderRepository orderRepository;

    OrderService(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    @Transactional
    OrderResponse create(CreateOrderRequest request) {
        Order order = Order.create(request.productId());
        orderRepository.save(order);
        return OrderResponse.from(order);
    }
}

@Repository
class OrderRepository {
    void save(Order order) {
        // EntityManager.persist(order) hoặc JDBC INSERT.
    }
}
```

Tách vai trò như vậy không phải để tạo thêm nhiều class một cách máy móc. Mục tiêu là giữ controller mỏng, business rule ở service và chi tiết persistence ở repository để code dễ test, thay đổi và review.

## 7. Câu hỏi đào sâu

> **`@Service` có thêm transaction tự động không?**

Không. `@Service` không tự mở transaction. Cần gắn `@Transactional` hoặc cấu hình transaction theo cách khác.

> **Tại sao không gắn `@Component` cho tất cả class để đơn giản?**

Ứng dụng vẫn có thể chạy, nhưng vai trò class trở nên mơ hồ. Khi đọc một class `@Repository`, người bảo trì biết nó không nên chứa business rule; khi đọc `@Service`, họ biết đây là nơi cần tìm use case và ranh giới transaction.

> **`@Repository` có tự động làm mọi exception DB thành `DataAccessException` không?**

Không phải trong mọi cấu hình. Việc dịch exception cần infrastructure phù hợp, chẳng hạn persistence exception translation post-processor. Nhiều abstraction của Spring như `JdbcTemplate` và Spring Data đã cung cấp cơ chế này sẵn.

> **Có nên đặt `@Transactional` ở repository không?**

Thông thường đặt transaction boundary ở service, vì một use case có thể gọi nhiều repository và cần commit/rollback như một đơn vị. Repository chỉ tập trung thao tác persistence. Có ngoại lệ, nhưng đây là mặc định tốt cho ứng dụng nghiệp vụ.

## 8. Tóm tắt

| Annotation | Vai trò chính | Điểm kỹ thuật cần nhớ |
|---|---|---|
| `@Component` | Bean hạ tầng/chung | Stereotype gốc cho component scan |
| `@Service` | Business logic/use case | Chủ yếu biểu đạt ý nghĩa kiến trúc |
| `@Repository` | Data access/persistence | Có thể là điểm dịch persistence exception sang `DataAccessException` |
| `@Controller` | MVC web handler | Để Spring MVC phát hiện request handler |
| `@RestController` | REST web handler | `@Controller` + `@ResponseBody` |

**Kết luận:** đừng chọn annotation chỉ vì chúng đều tạo bean. Chọn annotation mô tả đúng layer; chỉ dùng `@Component` khi class không thuộc rõ một stereotype chuyên biệt.