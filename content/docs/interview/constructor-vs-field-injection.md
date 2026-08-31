---
title: "Constructor injection khác gì field injection? Nên dùng cách nào?"
description: "Câu hỏi phỏng vấn Spring: so sánh constructor-based và field-based dependency injection, lý do constructor injection được khuyến nghị, cùng các trường hợp dependency tùy chọn."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây](#2-câu-trả-lời-30-giây)
- [3. Hai cách inject dependency](#3-hai-cách-inject-dependency)
- [4. Vì sao constructor injection được khuyến nghị](#4-vì-sao-constructor-injection-được-khuyến-nghị)
  - [Khai báo dependency rõ ràng và bất biến](#khai-báo-dependency-rõ-ràng-và-bất-biến)
  - [Dễ unit test, không cần Spring](#dễ-unit-test-không-cần-spring)
  - [Fail fast khi thiếu dependency](#fail-fast-khi-thiếu-dependency)
  - [Lộ ra circular dependency sớm](#lộ-ra-circular-dependency-sớm)
- [5. Field injection có vấn đề gì?](#5-field-injection-có-vấn-đề-gì)
- [6. Khi dependency là tùy chọn](#6-khi-dependency-là-tùy-chọn)
- [7. Quy tắc thực hành](#7-quy-tắc-thực-hành)
- [8. Tóm tắt](#8-tóm-tắt)

---

## 1. Câu hỏi phỏng vấn

> *"What is the difference between constructor-based and field-based dependency injection? Which one do you prefer, and why?"*
>
> Constructor-based injection và field-based injection khác nhau gì? Nên ưu tiên cách nào, và vì sao?

Đây là câu hỏi kiểm tra tư duy thiết kế class, không chỉ kiến thức annotation `@Autowired`. Cả hai cách đều có thể để Spring tiêm bean, nhưng chúng tạo ra các mức độ rõ ràng, khả năng test và an toàn khác nhau.

## 2. Câu trả lời 30 giây

Nên ưu tiên **constructor injection** cho các dependency bắt buộc. Dependency được khai báo ngay trong constructor, có thể lưu vào `final` field, class chỉ được tạo khi đã có đủ dependency, và unit test có thể khởi tạo class trực tiếp bằng mock mà không cần Spring context.

**Field injection** dùng `@Autowired` trực tiếp lên field. Nó ngắn hơn nhưng che giấu dependency, khiến object có thể được tạo trong trạng thái chưa hoàn chỉnh trước khi Spring inject field, không dùng được `final`, và làm unit test khó hơn vì phải dùng reflection hoặc khởi động Spring.

Trong Spring hiện đại, nếu class chỉ có **một constructor**, không cần viết `@Autowired` trên constructor đó. Với dependency tùy chọn, dùng `Optional`, `ObjectProvider`, `@Nullable` hoặc setter injection thay vì biến mọi dependency bắt buộc thành field injection.

## 3. Hai cách inject dependency

### Constructor-based injection

```java
@Service
public class OrderService {
    private final OrderRepository orderRepository;
    private final PaymentGateway paymentGateway;

    // Một constructor duy nhất: Spring tự dùng nó, không cần @Autowired.
    public OrderService(
            OrderRepository orderRepository,
            PaymentGateway paymentGateway) {
        this.orderRepository = orderRepository;
        this.paymentGateway = paymentGateway;
    }
}
```

Spring resolve các tham số constructor rồi mới tạo `OrderService`. Nếu có nhiều constructor, đánh dấu constructor cần Spring dùng bằng `@Autowired`.

### Field-based injection

```java
@Service
public class OrderService {
    @Autowired
    private OrderRepository orderRepository;

    @Autowired
    private PaymentGateway paymentGateway;
}
```

Với field injection, Spring gọi constructor mặc định trước, rồi `AutowiredAnnotationBeanPostProcessor` gán dependency vào field bằng reflection trong quá trình khởi tạo bean.

> [!NOTE]
> Field injection không sai về mặt cơ chế Spring; ứng dụng vẫn chạy. Vấn đề là thiết kế class và khả năng kiểm thử kém hơn, nên nó không phải lựa chọn mặc định cho production code.

## 4. Vì sao constructor injection được khuyến nghị

### Khai báo dependency rõ ràng và bất biến

Constructor là API tạo object. Nhìn vào nó, người đọc biết ngay class cần gì để thực hiện trách nhiệm của mình.

```java
public OrderService(OrderRepository orderRepository, PaymentGateway paymentGateway)
```

Các dependency bắt buộc có thể là `final`. Sau khi object được tạo, chúng không thể bị gán nhầm sang implementation khác.

Ngược lại, field injection che dependency trong thân class. Một class có 8 field `@Autowired` vẫn có constructor không tham số, khiến API bên ngoài trông như thể class không phụ thuộc gì.

### Dễ unit test, không cần Spring

Constructor injection cho phép tạo system under test trực tiếp:

```java
@Test
void createsOrderAfterPaymentSucceeds() {
    OrderRepository repository = mock(OrderRepository.class);
    PaymentGateway gateway = mock(PaymentGateway.class);
    OrderService service = new OrderService(repository, gateway);

    service.placeOrder(new CreateOrderCommand(42L));

    verify(repository).save(any(Order.class));
}
```

Không cần `@SpringBootTest`, không cần Spring context, và test chạy nhanh. Với field injection, test phải khởi động Spring để inject dependency hoặc dùng reflection để sửa private field; cả hai đều làm test dài dòng và gắn chặt với framework.

### Fail fast khi thiếu dependency

Nếu dependency là bắt buộc, constructor injection buộc caller cung cấp nó ngay lúc tạo object. Object không thể tồn tại ở trạng thái `orderRepository == null` do quên inject.

Với field injection, `new OrderService()` vẫn compile và tạo được object, nhưng gọi method trước khi Spring inject sẽ có thể ném `NullPointerException`.

```java
OrderService service = new OrderService(); // Có thể tạo nếu dùng field injection.
service.placeOrder(command);               // Có thể NPE vì field chưa được inject.
```

### Lộ ra circular dependency sớm

Giả sử `OrderService` cần `PaymentService`, đồng thời `PaymentService` cần `OrderService`:

```text
OrderService ──constructor──► PaymentService
      ▲                              │
      └────────constructor───────────┘
```

Constructor injection khiến Spring báo lỗi vòng lặp ngay trong lúc tạo bean, vì không bean nào có thể được tạo trước. Đây thường là tín hiệu thiết kế chưa tốt: hai service đang ôm trách nhiệm quá chặt và nên tách một abstraction hoặc điều phối qua service thứ ba.

Field/setter injection đôi khi có thể để Spring giải vòng lặp bằng early reference, tùy cấu hình và loại proxy. Tuy nhiên Spring Boot hiện đại mặc định không khuyến khích/cho phép circular reference. Không nên chọn field injection để che một vấn đề kiến trúc.

## 5. Field injection có vấn đề gì?

| Vấn đề | Hệ quả |
|---|---|
| Dependency bị ẩn | Không biết class cần gì nếu chỉ đọc constructor/API. |
| Không dùng `final` field | Dependency có thể bị thay đổi sau khi khởi tạo. |
| Khó unit test | Phải mở Spring context hoặc set private field bằng reflection. |
| Object có thể chưa hoàn chỉnh | `new` trực tiếp tạo object với các field là `null`. |
| Dễ phình class | Nhiều field inject thường là dấu hiệu class đang làm quá nhiều việc. |
| Dễ che circular dependency | Có thể trì hoãn lỗi thay vì buộc sửa thiết kế. |

Field injection vẫn có thể xuất hiện trong code cũ, test integration, hoặc một số framework không kiểm soát được cách tạo object. Nhưng với application bean tự viết, constructor injection là lựa chọn tốt hơn.

## 6. Khi dependency là tùy chọn

Constructor injection không có nghĩa mọi dependency phải tồn tại vô điều kiện. Hãy biểu diễn tính tùy chọn một cách rõ ràng.

### Dùng `Optional`

```java
@Service
public class NotificationService {
    private final Optional<SmsGateway> smsGateway;

    public NotificationService(Optional<SmsGateway> smsGateway) {
        this.smsGateway = smsGateway;
    }
}
```

### Dùng `ObjectProvider` khi chỉ cần tạo/lấy bean muộn

```java
@Service
public class ReportService {
    private final ObjectProvider<ExpensiveExporter> exporterProvider;

    public ReportService(ObjectProvider<ExpensiveExporter> exporterProvider) {
        this.exporterProvider = exporterProvider;
    }

    public void export() {
        exporterProvider.ifAvailable(ExpensiveExporter::export);
    }
}
```

### Dùng setter injection cho cấu hình tùy chọn thực sự

Setter injection phù hợp khi object vẫn hợp lệ nếu dependency không có, hoặc dependency cần được thay đổi sau lúc tạo. Đây là trường hợp ít gặp hơn dependency bắt buộc.

```java
@Component
public class AuditPublisher {
    private AuditSink auditSink = AuditSink.noop();

    @Autowired(required = false)
    public void setAuditSink(AuditSink auditSink) {
        this.auditSink = auditSink;
    }
}
```

> [!TIP]
> Nếu class không hoạt động đúng khi thiếu một dependency, dependency đó không phải optional. Hãy đặt nó vào constructor thay vì dùng `@Autowired(required = false)` để trì hoãn lỗi cấu hình.

## 7. Quy tắc thực hành

1. **Dependency bắt buộc → constructor injection.** Dùng `final` field.
2. **Class có một constructor → không cần `@Autowired`.** Spring Framework tự chọn constructor đó.
3. **Dependency tùy chọn → `Optional`, `ObjectProvider`, `@Nullable` hoặc setter injection.** Chọn cách thể hiện rõ lý do optional.
4. **Circular dependency → sửa thiết kế.** Không đổi sang field injection để làm lỗi biến mất.
5. **Dùng Lombok có kiểm soát.** `@RequiredArgsConstructor` có thể giảm boilerplate, miễn là các dependency bắt buộc vẫn là `final` và constructor vẫn rõ ràng qua source/IDE.

```java
@Service
@RequiredArgsConstructor
public class OrderService {
    private final OrderRepository orderRepository;
    private final PaymentGateway paymentGateway;
}
```

## 8. Tóm tắt

| Tiêu chí | Constructor injection | Field injection |
|---|---|---|
| Dependency hiển thị trong API | ✅ | ❌ |
| Dùng được `final` | ✅ | ❌ |
| Unit test không cần Spring | ✅ | ⚠️ Khó hơn |
| Object luôn đủ dependency khi tạo | ✅ | ❌ |
| Phát hiện circular dependency sớm | ✅ | ⚠️ Có thể bị che/khác theo cấu hình |
| Khuyến nghị cho app code | ✅ Mặc định | ❌ Tránh dùng |

**Kết luận:** ưu tiên constructor injection cho dependency bắt buộc. Field injection ngắn hơn vài dòng nhưng đánh đổi tính bất biến, khả năng test và độ minh bạch của class; lợi ích đó không đáng trong code production.