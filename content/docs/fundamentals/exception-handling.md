---
title: "Exception Handling — Deep Dive"
description: "Mổ xẻ Exception trong Java: cây Throwable (Error/Exception/RuntimeException), checked vs unchecked debate, JVM exception table & bytecode, try-with-resources internal (addSuppressed), exception cost (stack trace filling), multi-catch & rethrow, custom exception hierarchy, Spring @ExceptionHandler, và production error handling patterns. Kèm bytecode analysis, benchmark, và anti-patterns."
---

## Mục lục

- [Bối cảnh: API chậm 10x — exception dùng thay control flow](#1-bối-cảnh-api-chậm-10x--exception-dùng-thay-control-flow)
- [Cây phân cấp Throwable — Error, Exception, RuntimeException](#2-cây-phân-cấp-throwable--error-exception-runtimeexception)
- [Checked vs Unchecked — cuộc tranh luận chưa có hồi kết](#3-checked-vs-unchecked--cuộc-tranh-luận-chưa-có-hồi-kết)
- [JVM Exception Table — cách JVM dispatch exception](#4-jvm-exception-table--cách-jvm-dispatch-exception)
- [try-with-resources — AutoCloseable & Suppressed Exception](#5-try-with-resources--autocloseable--suppressed-exception)
- [Exception Cost — stack trace filling là bottleneck](#6-exception-cost--stack-trace-filling-là-bottleneck)
- [Multi-catch & Rethrow Pattern](#7-multi-catch--rethrow-pattern)
- [Custom Exception Hierarchy — thiết kế cho production](#8-custom-exception-hierarchy--thiết-kế-cho-production)
- [Spring Error Handling — @ExceptionHandler & ProblemDetail](#9-spring-error-handling--exceptionhandler--problemdetail)
- [Anti-patterns & Tóm tắt](#10-anti-patterns--tóm-tắt)

---

## 1. Bối cảnh: API chậm 10x — exception dùng thay control flow

Service validate input. Developer dùng exception để kiểm tra format:

```java
public boolean isValidEmail(String email) {
    try {
        new InternetAddress(email).validate();  // throw nếu invalid
        return true;
    } catch (AddressException e) {
        return false;                           // "tiện" — dùng exception như if/else
    }
}
```

Gọi 100.000 lần/phút với 80% email invalid → **80.000 exception/phút**. Profiler:

```
CPU: 40% trong fillInStackTrace()
     25% trong InternetAddress.validate()
     15% trong catch handler
     20% còn lại
```

`fillInStackTrace()` phải **crawl toàn bộ call stack** mỗi lần throw → tốn hàng chục microsecond. So với if/else (nanosecond): **chậm 100-1000x**.

Fix: validate bằng regex/logic trước, **chỉ throw khi thực sự exceptional**:

```java
private static final Pattern EMAIL = Pattern.compile("^[\\w.-]+@[\\w.-]+\\.[a-zA-Z]{2,}$");

public boolean isValidEmail(String email) {
    return email != null && EMAIL.matcher(email).matches();  // no exception
}
```

> [!IMPORTANT]
> Exception dành cho **tình huống bất thường** (exceptional), không phải control flow thay if/else. Chi phí throw+catch = `fillInStackTrace()` crawl stack + unwinding — đắt hơn branch prediction hàng trăm lần.

---

## 2. Cây phân cấp Throwable — Error, Exception, RuntimeException

```
                    Object
                      │
                  Throwable
                 ┌────┴────┐
               Error    Exception
                │       ┌────┴────────────────┐
                │   RuntimeException    (checked exceptions)
                │       │                     │
           OutOfMemory  NullPointer      IOException
           StackOverflow IllegalArgument  SQLException
           LinkageError  IndexOutOf       FileNotFoundException
                        ClassCast         InterruptedException
```

| Loại | Phải catch/declare? | Khi nào dùng | Ví dụ |
|------|--------------------|--------------|----|
| **Error** | **Không** — không nên catch | JVM hỏng, không recovery | `OutOfMemoryError`, `StackOverflowError` |
| **Checked Exception** | **Có** — compiler bắt buộc | Lỗi recovery được, caller cần biết | `IOException`, `SQLException` |
| **Unchecked (Runtime)** | **Không** — tuỳ chọn | Lỗi lập trình (bug) | `NullPointerException`, `IllegalArgumentException` |

> [!NOTE]
> `Error` extends `Throwable` trực tiếp — **không** phải `Exception`. Catch `Exception` **không** catch `Error`. Catch `Throwable` catch cả hai — nhưng gần như **không bao giờ** nên catch `Error`.

---

## 3. Checked vs Unchecked — cuộc tranh luận chưa có hồi kết

### 3.1. Ủng hộ Checked Exception

- Compiler **buộc** caller xử lý → không "quên" error case
- API contract rõ ràng: method signature cho biết error nào có thể xảy ra
- Ví dụ tốt: `IOException` — disk full, network down → caller **phải** biết để retry/fallback

### 3.2. Phản đối Checked Exception

- **Catch-and-ignore** ("nuốt exception") phổ biến khi developer lười:
  ```java
  try { ... } catch (Exception e) { /* TODO: handle later */ }  // 😱
  ```
- **Throw clause pollution**: `throws A, B, C, D` lan truyền lên cả call stack
- Lambda **không** cho phép checked exception → phải wrap:
  ```java
  list.stream().map(s -> {
      try { return parse(s); }         // parse() throws ParseException
      catch (ParseException e) { throw new RuntimeException(e); }  // ugly wrap
  });
  ```

### 3.3. Thực tế trong ecosystem

| Framework | Chiến lược |
|----------|-----------|
| **Spring** | Wrap checked → unchecked (`DataAccessException` wraps `SQLException`) |
| **Kotlin** | **Không** có checked exception |
| **Scala** | **Không** có checked exception |
| **Java Standard Library** | Dùng cả hai (IOException checked, NPE unchecked) |

> [!TIP]
> Quy tắc thực tế: dùng **checked** cho lỗi **caller có thể và nên xử lý** (retry, fallback). Dùng **unchecked** cho lỗi **lập trình** (null, invalid argument) hoặc lỗi **không recovery** (config sai, DB down). Khi không chắc → unchecked an toàn hơn.

---

## 4. JVM Exception Table — cách JVM dispatch exception

### 4.1. Exception Table trong bytecode

Mỗi method có **exception table** — JVM dùng để tìm catch handler:

```java
try {
    foo();          // (1) PC 0-3
} catch (IOException e) {
    handleIO(e);    // (2) handler PC 4
} catch (Exception e) {
    handleAll(e);   // (3) handler PC 8
}
```

Bytecode exception table:

```
Exception table:
  from  to  target  type
    0    3    4      java/io/IOException
    0    3    8      java/lang/Exception
```

Khi exception throw tại PC 0-3:
1. JVM duyệt **từ trên xuống** trong exception table
2. Match **type đầu tiên** `instanceof` exception → jump tới target PC
3. Không match → pop stack frame, lặp lại ở caller (unwinding)

### 4.2. finally — duplicate code, không phải magic

JDK compiler implement `finally` bằng cách **duplicate** finally block code vào **mọi** exit path (normal + mỗi catch + exceptional):

```java
try {
    foo();
} finally {
    cleanup();
}

// Compiler tạo:
// Path 1 (normal): foo() → cleanup() → return
// Path 2 (exception): foo() throws → cleanup() → rethrow
```

> [!NOTE]
> `finally` **luôn chạy** — kể cả khi có `return` trong try hoặc catch. Ngoại lệ duy nhất: `System.exit()`, thread bị kill, hoặc JVM crash.

---

## 5. try-with-resources — AutoCloseable & Suppressed Exception

### 5.1. Cú pháp và bytecode

```java
try (InputStream in = new FileInputStream("data.txt");
     BufferedReader br = new BufferedReader(new InputStreamReader(in))) {
    return br.readLine();
}
// Compiler tự gọi close() theo thứ tự ngược: br.close() → in.close()
```

Compiler desugar thành (simplified):

```java
InputStream in = new FileInputStream("data.txt");
Throwable primaryEx = null;
try {
    BufferedReader br = new BufferedReader(new InputStreamReader(in));
    try {
        return br.readLine();
    } catch (Throwable t) {
        primaryEx = t;
        throw t;
    } finally {
        if (br != null) {
            if (primaryEx != null) {
                try { br.close(); }
                catch (Throwable suppressed) {
                    primaryEx.addSuppressed(suppressed);  // ← suppressed!
                }
            } else {
                br.close();
            }
        }
    }
} finally {
    // tương tự cho in.close()
}
```

### 5.2. Suppressed Exception

Khi **cả** body throw **và** close() throw → body exception là primary, close exception là **suppressed**:

```java
try (MyResource r = new MyResource()) {
    throw new RuntimeException("body error");
} // r.close() cũng throw IOException

// Kết quả:
// RuntimeException: body error
//   Suppressed: IOException: close error
```

Đọc suppressed:

```java
catch (Exception e) {
    for (Throwable s : e.getSuppressed()) {
        log.warn("Suppressed: {}", s.getMessage());
    }
}
```

> [!TIP]
> **Luôn** dùng try-with-resources thay vì try-finally cho `AutoCloseable`. Nó xử lý đúng thứ tự close, suppressed exception, và null check — code bạn viết tay gần chắc chắn thiếu edge case.

---

## 6. Exception Cost — stack trace filling là bottleneck

### 6.1. fillInStackTrace() — chi phí ẩn

Khi `new Exception()` hoặc `throw`, JVM gọi `fillInStackTrace()` — **native method** crawl toàn bộ call stack, tạo `StackTraceElement[]`:

```
Benchmark                    Mode  Cnt    Score    Error  Units
throwCatchException          avgt   10   1842.3 ± 45.2   ns/op   ← ~2 μs
throwNoStackTrace            avgt   10     62.1 ±  3.4   ns/op   ← 30x nhanh hơn
ifElseControl                avgt   10      3.2 ±  0.1   ns/op   ← 600x nhanh hơn
```

### 6.2. Skip stack trace (khi cần performance)

```java
public class FastException extends RuntimeException {
    public FastException(String message) {
        super(message, null, true, false);  // writableStackTrace = false
    }

    @Override
    public synchronized Throwable fillInStackTrace() {
        return this;  // no-op — không crawl stack
    }
}
```

Use case: exception dùng cho **control flow nội bộ** (vd: `break` khỏi deep recursion), không cần stack trace cho debug.

### 6.3. Stack depth ảnh hưởng

Stack trace cost **tỷ lệ** với stack depth. Framework-heavy code (Spring, Hibernate) thường có stack 50-100 frame → `fillInStackTrace` đắt hơn.

> [!WARNING]
> Không pre-optimize exception handling. Chỉ tối ưu khi profiler **chỉ rõ** `fillInStackTrace` là bottleneck. Đa số ứng dụng throw exception hiếm khi → cost không đáng kể. Nhưng nếu throw **hàng nghìn/giây** (validation, parsing) → cân nhắc dùng return code hoặc Result type.

---

## 7. Multi-catch & Rethrow Pattern

### 7.1. Multi-catch (Java 7+)

```java
try {
    readFile();
} catch (FileNotFoundException | AccessDeniedException e) {
    // e là effectively final — không thể gán lại
    log.error("File error: {}", e.getMessage());
}
```

Bytecode: **1 catch handler** cho cả hai type → compact hơn 2 catch block riêng.

### 7.2. Precise rethrow (Java 7+)

```java
public void process() throws IOException, ParseException {
    try {
        readAndParse();     // throws IOException, ParseException
    } catch (Exception e) {
        log.error("Failed", e);
        throw e;            // compiler BIẾT e chỉ có thể là IOException | ParseException
    }
}
// Trước Java 7: phải declare throws Exception (quá rộng)
```

### 7.3. Exception chaining — wrap và rethrow

```java
try {
    jdbcTemplate.query(...);
} catch (DataAccessException e) {
    throw new OrderServiceException("Không thể load order", e);
    //                                                      └── cause chain
}

// Đọc chain:
catch (OrderServiceException e) {
    e.getCause();               // DataAccessException
    e.getCause().getCause();    // SQLException (nếu có)
}
```

> [!IMPORTANT]
> **Luôn** truyền `cause` khi wrap exception: `new CustomException(msg, originalException)`. Mất cause = mất thông tin debug → production sẽ **rất khó** trace root cause.

---

## 8. Custom Exception Hierarchy — thiết kế cho production

### 8.1. Base exception

```java
public abstract class AppException extends RuntimeException {
    private final String errorCode;       // "ORDER_NOT_FOUND", "PAYMENT_FAILED"
    private final HttpStatus httpStatus;  // map thẳng sang HTTP response

    protected AppException(String errorCode, String message,
                           HttpStatus status, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
        this.httpStatus = status;
    }

    // getters...
}
```

### 8.2. Specific exceptions

```java
public class NotFoundException extends AppException {
    public NotFoundException(String resource, Object id) {
        super(resource + "_NOT_FOUND",
              resource + " with id " + id + " not found",
              HttpStatus.NOT_FOUND, null);
    }
}

public class BusinessException extends AppException {
    public BusinessException(String errorCode, String message) {
        super(errorCode, message, HttpStatus.UNPROCESSABLE_ENTITY, null);
    }
}
```

### 8.3. Nguyên tắc

| Quy tắc | Lý do |
|---------|-------|
| Extends `RuntimeException` (unchecked) | Tránh throws pollution, Spring @Transactional rollback mặc định |
| Có `errorCode` | Client dùng code để i18n, switch logic |
| Có `httpStatus` | Centralize mapping, không scatter khắp controller |
| **Không** quá nhiều subclass | 5-10 exception types là đủ cho hầu hết service |

---

## 9. Spring Error Handling — @ExceptionHandler & ProblemDetail

### 9.1. @ControllerAdvice + @ExceptionHandler

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(NotFoundException.class)
    ProblemDetail handleNotFound(NotFoundException ex) {
        ProblemDetail pd = ProblemDetail.forStatus(ex.getHttpStatus());
        pd.setTitle("Resource Not Found");
        pd.setDetail(ex.getMessage());
        pd.setProperty("errorCode", ex.getErrorCode());
        return pd;
    }

    @ExceptionHandler(Exception.class)
    ProblemDetail handleGeneric(Exception ex) {
        log.error("Unexpected error", ex);
        ProblemDetail pd = ProblemDetail.forStatus(500);
        pd.setTitle("Internal Server Error");
        pd.setDetail("An unexpected error occurred");
        // KHÔNG expose internal message cho client
        return pd;
    }
}
```

### 9.2. ProblemDetail (RFC 7807) — Spring 6+

```json
{
  "type": "about:blank",
  "title": "Resource Not Found",
  "status": 404,
  "detail": "Order with id 123 not found",
  "errorCode": "ORDER_NOT_FOUND",
  "instance": "/api/orders/123"
}
```

> [!TIP]
> `ProblemDetail` là standard **RFC 7807** — response format thống nhất cho API error. Spring 6+ hỗ trợ native. Client biết cách parse không cần doc custom error format.

---

## 10. Anti-patterns & Tóm tắt

### Anti-patterns

| Anti-pattern | Vì sao sai | Sửa |
|--------------|-----------|-----|
| `catch (Exception e) {}` — nuốt exception | Mất hết thông tin lỗi | Log + rethrow hoặc handle đúng |
| Exception thay control flow | fillInStackTrace đắt | if/else, Optional, Result type |
| `catch (Throwable t)` | Catch cả Error (OOM, SOE) | Chỉ catch Exception |
| `throw new Exception("msg")` | Quá generic, caller không phân biệt | Custom exception với error code |
| Wrap exception mà mất cause | Mất root cause khi debug | `new CustomEx(msg, originalEx)` |
| Log rồi throw cùng exception | Duplicate log (mỗi layer log 1 lần) | Log ở **1 nơi** (top-level handler) |
| `throws Exception` trên mọi method | Vô nghĩa — caller không biết handle gì | Declare exception cụ thể |
| Return null thay vì throw | Caller quên check null → NPE xa nguồn lỗi | Throw hoặc `Optional` |

### Tóm tắt — Cheat sheet

```
Exception = tình huống bất thường, KHÔNG phải control flow

1. Throwable → Error (JVM) + Exception → RuntimeException (unchecked) + checked
2. Checked: caller PHẢI handle. Unchecked: tuỳ chọn
3. try-with-resources: auto close + suppressed exception handling
4. fillInStackTrace: O(stack depth) — đắt khi throw nhiều
5. Luôn truyền cause khi wrap: new CustomEx(msg, cause)
6. Custom hierarchy: errorCode + httpStatus + extends RuntimeException
7. Spring: @RestControllerAdvice + @ExceptionHandler + ProblemDetail (RFC 7807)
```

| Cần gì | Dùng gì |
|--------|---------|
| Lỗi caller có thể retry/fallback | Checked exception |
| Lỗi lập trình (bug) | Unchecked (`IllegalArgumentException`, `NullPointerException`) |
| Close resource | try-with-resources |
| High-performance validation | Return code / Result type, không throw |
| API error response | `@ExceptionHandler` + `ProblemDetail` |
| Tìm root cause | `exception.getCause()` chain |

> [!TIP]
> Một câu để nhớ: *Exception dành cho tình huống bất thường — nếu bạn expect nó xảy ra thường xuyên, đó không phải exception mà là business logic.* Throw ít, throw đúng, và luôn giữ cause chain.
