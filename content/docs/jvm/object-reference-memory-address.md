---
title: "Object, Reference và Memory Address trong Java"
description: "Giải thích object và reference được biểu diễn, lưu trữ và GC quản lý thế nào trong JVM: object graph, stack/heap/static, địa chỉ bộ nhớ, compressed oops, moving GC, GC Roots và các hiểu lầm phỏng vấn thường gặp."
---

> **Phân biệt quan trọng:** Java code làm việc với **reference**, không làm việc trực tiếp với địa chỉ RAM. Có thể dùng “địa chỉ” để hình dung reference trỏ đến object, nhưng Java Language Specification không cam kết reference là một raw memory address cố định.

## Mục lục

- [1. Ba khái niệm phải tách riêng](#1-ba-khái-niệm-phải-tách-riêng)
- [2. Reference có phải memory address không?](#2-reference-có-phải-memory-address-không)
- [3. Object và reference được lưu ở đâu?](#3-object-và-reference-được-lưu-ở-đâu)
  - [3.1 Local variable và method parameter](#31-local-variable-và-method-parameter)
  - [3.2 Instance field và array element](#32-instance-field-và-array-element)
  - [3.3 Static field](#33-static-field)
- [4. Từ biến Java đến object graph](#4-từ-biến-java-đến-object-graph)
- [5. Object được tạo và có layout ra sao?](#5-object-được-tạo-và-có-layout-ra-sao)
- [6. Garbage Collector quản lý reference thế nào?](#6-garbage-collector-quản-lý-reference-thế-nào)
  - [6.1 GC Roots và reachability](#61-gc-roots-và-reachability)
  - [6.2 GC không dựa vào reference count](#62-gc-không-dựa-vào-reference-count)
  - [6.3 Moving GC: object đổi chỗ nhưng reference vẫn hợp lệ](#63-moving-gc-object-đổi-chỗ-nhưng-reference-vẫn-hợp-lệ)
- [7. Compressed Oops và vì sao kích thước reference không cố định](#7-compressed-oops-và-vì-sao-kích-thước-reference-không-cố-định)
- [8. Reference trong lời gọi method: liên hệ pass-by-value](#8-reference-trong-lời-gọi-method-liên-hệ-pass-by-value)
- [9. null, dangling pointer và memory leak](#9-null-dangling-pointer-và-memory-leak)
- [10. Cách quan sát thực tế mà không đoán địa chỉ](#10-cách-quan-sát-thực-tế-mà-không-đoán-địa-chỉ)
- [11. Câu hỏi phỏng vấn và câu trả lời mẫu](#11-câu-hỏi-phỏng-vấn-và-câu-trả-lời-mẫu)
- [12. Cheat sheet](#12-cheat-sheet)

---

## 1. Ba khái niệm phải tách riêng

Nhìn dòng code quen thuộc này:

```java
User user = new User("An");
```

Có ba thực thể khác nhau:

| Khái niệm | Trong ví dụ | Ý nghĩa |
|---|---|---|
| **Biến** | `user` | Một slot giữ một giá trị và có thể được gán lại |
| **Reference** | `R1` (nhãn minh họa) | Giá trị cho biết object nào đang được tham chiếu |
| **Object** | `new User("An")` | Dữ liệu thật: object có field, header, và trạng thái riêng |

```text
Biến local trong method                 Object trên heap
┌──────────────────┐                   ┌──────────────────────────┐
│ user             │                   │ User                     │
│ value = ref R1   │ ───────────────►  │   name = "An"            │
└──────────────────┘                   └──────────────────────────┘
             reference R1
```

`user` không “chứa object”. Nó chứa một **reference value**. Object thật tồn tại độc lập cho đến khi không còn đường đi hợp lệ nào từ GC Roots tới nó.

> [!IMPORTANT]
> Một object có thể được nhiều reference trỏ tới. Ngược lại, một reference tại một thời điểm chỉ là `null` hoặc trỏ đến một object/mảng cụ thể.

```java
User first = new User("An");
User second = first;  // không tạo User thứ hai
second.name = "Bình";
System.out.println(first.name); // Bình
```

`first` và `second` là hai biến khác nhau, nhưng cùng giữ reference `R1` tới **một** object.

## 2. Reference có phải memory address không?

Ở mức học Java cơ bản, có thể hình dung reference như “địa chỉ dẫn tới object”. Cách ví von này giúp giải thích `null`, aliasing và pass-by-value. Nhưng câu trả lời phỏng vấn chính xác hơn là:

> **Reference là một giá trị do JVM quản lý để tham chiếu một object; nó không phải địa chỉ RAM thô mà Java code được phép đọc hoặc giữ cố định.**

Lý do không nên đồng nhất reference với địa chỉ RAM:

- Garbage Collector có thể **di chuyển object** trong heap khi compact/copy. Nếu Java giữ raw pointer cố định, mọi pointer tới object sẽ hỏng sau khi object chuyển chỗ.
- HotSpot có thể dùng **compressed ordinary object pointers** (compressed oops): reference vật lý có thể chỉ là offset nén, không phải pointer 64-bit đầy đủ.
- JIT có thể giữ reference trong **CPU register**, scalar-replace object, hoặc tối ưu bỏ hẳn allocation. Mô hình “luôn có một địa chỉ heap nhìn thấy được” không đúng trong mọi thời điểm.
- Java không có API chuẩn để lấy địa chỉ object. `System.identityHashCode()` là mã định danh, **không phải địa chỉ**.

```java
Object object = new Object();
System.out.println(System.identityHashCode(object));
```

Dòng trên chỉ hữu ích để kiểm tra hai reference có cùng identity hay không. Nó không cho biết object đang ở byte nào trong RAM và không được dùng làm pointer.

| Cách nói | Độ chính xác |
|---|---|
| “Reference giống địa chỉ để dễ hình dung.” | Chấp nhận được khi nhập môn |
| “Reference là raw memory address cố định.” | Sai hoặc quá đơn giản hóa |
| “JVM dùng reference để định vị object và có thể đổi cách biểu diễn/di chuyển object.” | Đúng và an toàn |

## 3. Object và reference được lưu ở đâu?

Câu trả lời ngắn: **object/mảng thường ở heap; reference có thể xuất hiện ở nhiều nơi**, tùy biến nào đang giữ nó. Đừng nói “reference luôn nằm ở stack” — đó là sai.

### 3.1 Local variable và method parameter

Một local variable hoặc parameter kiểu object nằm trong frame của method đang chạy. Frame thuộc JVM stack của thread đó. Slot local giữ **reference**, còn object được reference trỏ tới thường ở heap.

```java
void greet(User user) {       // parameter `user`: reference trong frame greet
    String name = user.name;  // `name`: reference trong frame greet
}

void run() {
    User local = new User("An"); // `local`: reference trong frame run
    greet(local);                  // copy giá trị reference sang parameter
}
```

```text
JVM stack của cùng một thread                         Heap
┌──────────────────── frame run ──────────────────┐  ┌─────────────────────┐
│ local = R1 ─────────────────────────────────────┼─►│ User                │
└─────────────────────────────────────────────────┘  │ name = R2 ───────┐  │
                                                     └──────────────────┼──┘
┌────────────────── frame greet ──────────────────┐                    ▼
│ user = R1 ──────────────────────────────────────┼────────────► ┌──────────┐
│ name = R2 ──────────────────────────────────────┼────────────► │ "An"     │
└─────────────────────────────────────────────────┘              └──────────┘
```

Khi `greet` return, frame `greet` bị pop và các slot `user`, `name` biến mất. Object không tự động biến mất chỉ vì một reference biến mất; nó chỉ đủ điều kiện GC nếu không còn **bất kỳ** path nào từ GC Roots.

### 3.2 Instance field và array element

Nếu một reference là field của object, reference đó nằm **bên trong object trên heap**. Nếu nó là phần tử của mảng object, reference đó nằm trong **mảng trên heap**.

```java
class Team {
    User leader;              // reference field, nằm trong Team object
}

Team team = new Team();
team.leader = new User("An");

User[] members = new User[2]; // array object trên heap
members[0] = team.leader;     // reference element nằm trong array object
```

```text
stack                              heap
team = R1 ───────────────────►  Team object
                                 leader = R2 ────────────► User("An")

members = R3 ─────────────────► User[] object
                                 [0] = R2 ───────────────► cùng User("An")
                                 [1] = null
```

Đây là lý do một object có thể sống rất lâu: một collection, cache, static map hoặc object parent vẫn còn reference tới nó.

### 3.3 Static field

Static field gắn với class và được JVM xem như một GC Root trong khi class còn được nạp. Object được static field giữ thường sống rất lâu.

```java
class UserCache {
    static final Map<String, User> CACHE = new HashMap<>();
}
```

```text
GC Root (class UserCache)
        │
        ▼
     CACHE map ──► entries ──► User objects
```

`static` không có nghĩa object “không bao giờ bị GC”. Nó có nghĩa object vẫn reachable **chừng nào class và static field còn reachable**. Với class loader của application thông thường, điều này thường kéo dài hết vòng đời process. Đây là nguồn memory leak phổ biến nếu cache không có eviction.

## 4. Từ biến Java đến object graph

Thay vì xem bộ nhớ như những object rời rạc, hãy xem nó là một **object graph**: node là object; cạnh là reference field, array element hoặc local/static reference.

```java
Order order = new Order(customer, items);
```

```text
GC Root: local variable `order`
              │
              ▼
           Order
          /     \
         ▼       ▼
   Customer     List<Item>
                  │
             ┌────┴────┐
             ▼         ▼
           Item      Item
```

Khi local `order` không còn tồn tại sau khi method return, toàn bộ graph phía dưới **có thể** trở thành rác — nhưng chỉ khi không object nào trong graph còn được trỏ tới bởi một path khác từ GC Root.

Ví dụ, nếu `customer` đồng thời có trong `static Map`, `Customer` vẫn sống. Các `Item` chỉ còn được truy cập qua `order` có thể được GC. GC xét từng object và các path thực tế, không xóa cả graph một cách mù quáng.

## 5. Object được tạo và có layout ra sao?

Khi chạy `new User("An")`, JVM cần cấp phát bộ nhớ cho object. Với HotSpot, object thường có cấu trúc khái niệm sau:

```text
┌──────────────────── Object trên heap ────────────────────┐
│ Object header                                            │
│  • Mark word: hash/GC age/trạng thái lock ...            │
│  • Klass pointer: metadata của class User                │
├──────────────────────────────────────────────────────────┤
│ Instance fields                                          │
│  • name: reference R2 ────────────────────────────────► String object
│  • age : primitive int 30                                │
├──────────────────────────────────────────────────────────┤
│ Padding để đáp ứng alignment                             │
└──────────────────────────────────────────────────────────┘
```

- **Object header** chứa metadata phục vụ JVM, không phải field bạn khai báo.
- Field primitive như `int age` chứa giá trị trực tiếp trong object.
- Field kiểu object như `String name` chứa **reference** tới object khác, không nhúng toàn bộ `String` vào `User`.
- Kích thước và thứ tự field phụ thuộc JVM, kiến trúc CPU, alignment và các tối ưu; không tự tính bằng trực giác để tối ưu production.

Ở HotSpot hiện đại, allocation object sống ngắn thường đi vào vùng cấp phát riêng theo thread (**TLAB — Thread-Local Allocation Buffer**) trong young generation. Cấp phát phổ biến chỉ là tăng một con trỏ trong TLAB, nên `new` không mặc định đồng nghĩa với “chậm”.

> [!NOTE]
> “Object luôn ở heap” là mô hình ngôn ngữ hữu ích. JIT có thể dùng escape analysis và scalar replacement để tránh allocation vật lý của object không thoát khỏi method. Đừng xây logic dựa trên vị trí vật lý cụ thể của object.

## 6. Garbage Collector quản lý reference thế nào?

GC không đi qua heap theo kiểu “đếm xem mỗi object có bao nhiêu biến đang trỏ tới”. Nó bắt đầu từ các điểm gốc còn sống, đi theo các strong reference, rồi giữ lại những object còn đi tới được.

### 6.1 GC Roots và reachability

Một số GC Roots thường gặp:

| GC Root | Ví dụ |
|---|---|
| Local variable/parameter của method đang chạy | `User currentUser` trong request đang xử lý |
| Thread đang sống | `Thread` và state liên quan |
| Static field của class đã load | `static final Map CACHE` |
| JNI reference | Object bị native code giữ |
| Internal JVM structures | Class loader, synchronized monitor, JIT structures |

```text
GC Root
  │
  ├──► static CACHE ───► User A       => sống
  │
  └──► local order ────► Item B       => sống khi method đang chạy

Object C không có path từ GC Root     => eligible for GC
```

“Eligible for GC” không có nghĩa bị thu hồi ngay lập tức. Thời điểm GC chạy và collector nào thu hồi là quyết định của JVM.

### 6.2 GC không dựa vào reference count

Nếu GC chỉ đếm số reference, một vòng object sẽ không bao giờ được dọn:

```java
class Node {
    Node next;
}

Node first = new Node();
Node second = new Node();
first.next = second;
second.next = first;

first = null;
second = null;
```

`Node` vẫn trỏ lẫn nhau, nhưng không còn path nào từ GC Root tới chúng. JVM dùng **tracing reachability**, nên vẫn có thể thu hồi cả vòng này. Đây là một lợi thế quan trọng so với reference counting thuần túy.

### 6.3 Moving GC: object đổi chỗ nhưng reference vẫn hợp lệ

Nhiều collector hiện đại copy hoặc compact object sống để giảm phân mảnh. Vì vậy một object có thể chuyển từ vùng heap cũ sang vùng mới trong lúc GC.

```text
Trước GC:
local user = R1 ───────► [User ở vùng heap A]

GC copy/compact:
local user = R1 ───────► [User ở vùng heap B]
                             ▲
                      JVM đã cập nhật reference/metadata cần thiết
```

JVM đảm bảo Java code không thấy object bị “mất địa chỉ”. Tùy collector, JVM dùng kỹ thuật như cập nhật reference khi compact, forwarding pointer, hay read/write barrier để giữ việc truy cập an toàn trong và sau GC.

Đây là lý do không thể lưu một “địa chỉ object” rồi dùng nó mãi mãi trong Java. Object identity có thể giữ nguyên, nhưng vị trí vật lý có thể đổi.

## 7. Compressed Oops và vì sao kích thước reference không cố định

Trên JVM 64-bit, một reference **không mặc định luôn là 8 byte**. HotSpot thường bật **Compressed Oops** khi heap đủ nhỏ (thường dưới khoảng 32 GB, tùy cấu hình JVM). Khi đó reference được lưu dạng giá trị nén, thường 4 byte, rồi JVM giải mã thành địa chỉ khi cần.

```text
Compressed reference (khái niệm):
physical address ≈ heap_base + (encoded_reference << alignment_shift)
```

Ý nghĩa thực tế:

- Object có nhiều field reference (`List`, tree node, DTO...) có thể giảm đáng kể bộ nhớ.
- Không nên tự hard-code “một reference bằng 4 byte/8 byte” trong tính toán Java portable.
- `-XX:+UseCompressedOops` thường được HotSpot tự quyết định; chỉ điều chỉnh khi có số liệu và hiểu trade-off.

Dùng **JOL (Java Object Layout)** nếu cần đo layout thật trên JVM đang chạy. Đừng dùng `Runtime.freeMemory()` để suy ra kích thước một object.

## 8. Reference trong lời gọi method: liên hệ pass-by-value

Khi gọi method với một object variable, Java copy **giá trị reference** vào parameter. Nó không copy object, và cũng không cho parameter trở thành alias của biến caller.

```java
static void mutate(User parameter) {
    parameter.name = "Bình";          // sửa object chung
}

static void reassign(User parameter) {
    parameter = new User("Chi");      // chỉ đổi reference trong method
}

User user = new User("An");
mutate(user);    // user.name là "Bình"
reassign(user);  // user vẫn trỏ User("Bình")
```

```text
Gọi mutate(user) hoặc reassign(user):

caller frame:    user      = R1 ──► User("An")
method frame:    parameter = R1 ──► cùng User("An")

`parameter.name = ...`  → đổi object R1 trỏ tới
`parameter = R2`        → chỉ đổi slot parameter trong method frame
```

Để đào sâu riêng chủ đề này, xem [Java luôn Pass-by-Value](/interview/java-pass-by-value-vs-pass-by-reference/).

## 9. null, dangling pointer và memory leak

### `null`

`null` là giá trị reference đặc biệt: nó không trỏ tới object nào. Truy cập field/method qua `null` gây `NullPointerException`.

```java
User user = null;
System.out.println(user.name); // NullPointerException
```

### Dangling pointer

Trong ngôn ngữ quản lý thủ công, dangling pointer là pointer vẫn trỏ vào vùng nhớ đã bị giải phóng. Java gần như loại bỏ lỗi này trong code an toàn: khi object còn reachable, GC không thu hồi nó; khi object đã bị thu hồi, Java code không còn reference hợp lệ để truy cập nó.

`Unsafe`, JNI hoặc native memory có thể phá vỡ các bảo đảm này, nhưng không phải mô hình Java thông thường.

### Memory leak

Java vẫn có memory leak. Leak không phải là “GC quên dọn” mà là **application vô tình còn giữ strong reference** đến object không cần nữa.

```java
class BadCache {
    static final List<byte[]> ALL_REQUESTS = new ArrayList<>();

    void handleRequest(byte[] body) {
        ALL_REQUESTS.add(body); // body luôn reachable qua static list
    }
}
```

GC hoạt động đúng: `body` còn reachable qua `BadCache.ALL_REQUESTS`, nên nó không được phép xóa. Cách sửa là thiết kế cache có giới hạn/eviction, xóa reference không còn cần, hoặc thay đổi ownership của object.

## 10. Cách quan sát thực tế mà không đoán địa chỉ

| Mục tiêu | Công cụ/cách phù hợp | Không nên dùng |
|---|---|---|
| Kiểm tra cùng object identity | `==`, `System.identityHashCode()` để log | So sánh `hashCode()` override |
| Kiểm tra layout object | JOL | Tự đoán 4/8 byte |
| Tìm object giữ bộ nhớ | Heap dump + Eclipse MAT/JDK Mission Control | Gọi `System.gc()` để “sửa leak” |
| Quan sát allocation/GC | Java Flight Recorder (JFR), JDK Mission Control, `jcmd` | Đo bằng `Runtime.freeMemory()` đơn lẻ |

Ví dụ kiểm tra identity, không phải địa chỉ:

```java
User first = new User("An");
User second = first;
User third = new User("An");

System.out.println(first == second); // true: cùng object
System.out.println(first == third);  // false: hai object khác nhau
```

Để lấy heap dump khi OOM:

```bash
java -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=./dumps -jar app.jar
```

Sau đó mở file `.hprof` bằng Eclipse MAT và xem **Path to GC Roots**. Báo cáo này trả lời đúng câu hỏi quan trọng: *reference nào đang giữ object không được GC?*

## 11. Câu hỏi phỏng vấn và câu trả lời mẫu

> **“Reference trong Java có phải memory address không?”**

Có thể coi nó giống địa chỉ khi giải thích cơ bản, nhưng không phải raw address được Java cam kết. JVM có thể nén reference hoặc di chuyển object trong quá trình GC. Java chỉ đảm bảo reference định vị đúng object khi object còn sống.

> **“Object nằm ở heap, reference nằm ở đâu?”**

Object/mảng thường ở heap. Reference nằm tại nơi biến đang giữ nó: local/parameter thường trong stack frame, field/reference element trong object/mảng trên heap, static field trong dữ liệu class. Vì vậy “reference luôn ở stack” là sai.

> **“GC biết object nào cần xóa bằng cách nào?”**

GC bắt đầu từ GC Roots rồi trace qua reference. Object không có path từ bất kỳ GC Root nào thì unreachable và eligible for collection. GC không dùng reference count thuần túy, nên vẫn xóa được vòng object trỏ lẫn nhau.

> **“Object bị GC di chuyển thì reference cũ sao không hỏng?”**

JVM chịu trách nhiệm giữ reference hợp lệ bằng cơ chế compact/copy và cập nhật/forward reference hoặc barrier tùy collector. Java code không làm việc với raw address, nên không thấy việc di chuyển này.

> **“`System.identityHashCode()` có phải memory address không?”**

Không. Nó là identity hash code và có thể dùng để log/phân biệt object trong một lần chạy, nhưng không là địa chỉ và không được dùng để truy cập object.

## 12. Cheat sheet

```text
Biến       = một slot có thể giữ giá trị
Reference  = giá trị trỏ/định vị object; không nhất thiết là raw address
Object     = dữ liệu thật gồm header + fields, thường ở heap

Local ref/parameter  → thường ở stack frame
Field/array ref      → nằm trong object/mảng trên heap
Static ref           → gắn với class, thường là GC Root

GC Roots → trace reference graph → giữ object reachable
Không reachable → eligible for GC
GC có thể di chuyển object; JVM giữ reference hợp lệ

Java truyền object reference BY VALUE, không pass-by-reference
```

**Ba nguyên tắc để trả lời phỏng vấn:**

1. Nói **reference là giá trị do JVM quản lý**, không khẳng định đó là raw memory address cố định.
2. Phân biệt rõ **vị trí của object** với **vị trí của reference variable**.
3. Giải thích GC bằng **GC Roots + object graph + reachability**, không phải “hết scope là object bị xóa ngay”.
