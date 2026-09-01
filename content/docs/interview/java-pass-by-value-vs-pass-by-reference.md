---
title: "Java luôn Pass-by-Value: vì sao sửa object được nhưng swap lại không được?"
description: "Câu hỏi phỏng vấn Java về pass-by-value và hiểu lầm pass-by-reference: copy primitive, copy reference, mutate vs reassign, swap, String/Integer immutable, cùng cách trả lời trong 30 giây."
---

> **Câu chốt cần nhớ:** Java **luôn luôn pass-by-value**. Khi truyền object, Java copy **giá trị của reference** vào tham số; hai reference sau đó cùng trỏ đến một object. Vì vậy method có thể sửa *object*, nhưng không thể gán lại *biến của người gọi*.

## Mục lục

- [1. Trước hết: “truyền tham trị” và “truyền tham chiếu” là gì?](#1-trước-hết-truyền-tham-trị-và-truyền-tham-chiếu-là-gì)
  - [1.1 Biến, object và reference là ba thứ khác nhau](#11-biến-object-và-reference-là-ba-thứ-khác-nhau)
  - [1.2 Pass-by-value: method nhận bản sao](#12-pass-by-value-method-nhận-bản-sao)
  - [1.3 Pass-by-reference: method nhận quyền đổi biến gốc](#13-pass-by-reference-method-nhận-quyền-đổi-biến-gốc)
- [2. Điểm gây nhầm: “truyền reference” không đồng nghĩa pass-by-reference](#2-điểm-gây-nhầm-truyền-reference-không-đồng-nghĩa-pass-by-reference)
- [3. Câu hỏi phỏng vấn](#3-câu-hỏi-phỏng-vấn)
- [4. Câu trả lời 30 giây](#4-câu-trả-lời-30-giây)
- [5. Quy tắc duy nhất: Java copy giá trị](#5-quy-tắc-duy-nhất-java-copy-giá-trị)
- [6. Primitive: copy dữ liệu](#6-primitive-copy-dữ-liệu)
- [7. Object: copy reference, không copy object](#7-object-copy-reference-không-copy-object)
  - [7.1 Sửa object: người gọi thấy thay đổi](#71-sửa-object-người-gọi-thấy-thay-đổi)
  - [7.2 Gán lại tham số: người gọi không thấy thay đổi](#72-gán-lại-tham-số-người-gọi-không-thấy-thay-đổi)
  - [7.3 Vì sao không thể swap hai object qua method?](#73-vì-sao-không-thể-swap-hai-object-qua-method)
- [8. Pass-by-reference thật sự là gì?](#8-pass-by-reference-thật-sự-là-gì)
- [9. Các bẫy phỏng vấn thường gặp](#9-các-bẫy-phỏng-vấn-thường-gặp)
  - [9.1 String và Integer là immutable](#91-string-và-integer-là-immutable)
  - [9.2 Mảng, List và Map vẫn có thể bị sửa](#92-mảng-list-và-map-vẫn-có-thể-bị-sửa)
  - [9.3 null cũng là một giá trị reference](#93-null-cũng-là-một-giá-trị-reference)
- [10. Muốn thay đổi biến của người gọi thì làm thế nào?](#10-muốn-thay-đổi-biến-của-người-gọi-thì-làm-thế-nào)
- [11. Câu hỏi đào sâu và câu trả lời mẫu](#11-câu-hỏi-đào-sâu-và-câu-trả-lời-mẫu)
- [12. Cheat sheet](#12-cheat-sheet)

---

## 1. Trước hết: “truyền tham trị” và “truyền tham chiếu” là gì?

Đừng bắt đầu bằng `String`, `List` hay heap/stack. Trước hết, hãy trả lời một câu đơn giản: **method nhận một bản sao của biến, hay nhận quyền thay đổi chính biến của caller?** Hai cơ chế truyền tham số khác nhau ở đúng điểm này.

### 1.1 Biến, object và reference là ba thứ khác nhau

Với đoạn code sau, có ba khái niệm cần tách riêng:

```java
User user = new User("An");
```

```text
(1) Biến `user`                 (2) Giá trị trong biến          (3) Object thật
┌─────────────────┐             ┌──────────────────┐           ┌──────────────────────┐
│ user            │  chứa       │ reference U1     │  trỏ tới  │ User { name = "An" } │
└─────────────────┘             └──────────────────┘           └──────────────────────┘
```

- **Biến** `user` là một “ô” có thể giữ một giá trị.
- **Object** `new User("An")` là dữ liệu thực: nó có field `name`.
- **Reference** `U1` là giá trị cho biết biến đang trỏ tới object nào. Trong tài liệu này, `U1` chỉ là nhãn minh họa, không phải địa chỉ RAM thật.

Vì vậy, nói chính xác không phải là “biến `user` là object”. `user` **giữ reference đến object**.

### 1.2 Pass-by-value: method nhận bản sao

**Pass-by-value** nghĩa là: khi gọi method, giá trị trong argument được **copy** sang parameter. Sau đó caller và method có hai biến khác nhau. Gán lại parameter chỉ tác động bản sao trong method.

```text
Caller:  x = 10
Gọi:     increase(x)
Method:  number = 10     ← number là bản sao của giá trị x

number = 20              ← chỉ đổi number, x vẫn là 10
```

Điểm kiểm tra là: **method không thể gán lại biến `x` của caller**.

### 1.3 Pass-by-reference: method nhận quyền đổi biến gốc

**Pass-by-reference** nghĩa là: parameter là một alias của chính biến bên caller. Method không nhận một biến mới chứa bản sao; nó được phép thao tác trực tiếp lên ô biến gốc.

```text
Caller:  x = 10
Gọi:     setToTwenty(x)
Method:  parameter là alias của x

parameter = 20           ← x của caller cũng thành 20
```

Đây mới là ý nghĩa của cụm “truyền tham chiếu” trong thuật ngữ *pass-by-reference*. Nếu gán lại parameter mà biến caller không đổi, cơ chế đó **không phải** pass-by-reference.

| Câu hỏi kiểm tra | Pass-by-value | Pass-by-reference |
|---|---|---|
| Method có một parameter/ô biến riêng? | Có | Không; parameter là alias biến caller |
| Gán lại parameter có đổi biến caller? | Không | Có |
| Có thể swap hai biến caller chỉ bằng swap parameter? | Không | Có |

## 2. Điểm gây nhầm: “truyền reference” không đồng nghĩa pass-by-reference

Có hai câu gần giống nhau nhưng nghĩa hoàn toàn khác:

1. **Pass a reference by value** — copy *giá trị reference*. Đây là Java.
2. **Pass by reference** — cho method quyền gán lại *biến của caller*. Java không làm điều này.

Hãy dùng ví dụ hai tờ giấy ghi địa chỉ nhà:

```text
Object = căn nhà ở U1
Reference = tờ giấy ghi “U1”

Java gọi method:
caller giữ tờ giấy U1  ── photocopy ──► method nhận một tờ giấy U1 khác
```

Hai tờ giấy cùng dẫn tới một căn nhà. Do đó method có thể tới căn nhà và sơn lại tường — tức là sửa object. Nhưng nếu method tẩy `U1` trên **tờ giấy của nó** rồi ghi `U2`, tờ giấy của caller vẫn ghi `U1`. Đây là lý do hai phát biểu sau cùng đúng:

- Object có thể bị sửa qua parameter.
- Java vẫn luôn truyền theo giá trị, vì Java đã copy **giá trị reference** `U1`.

> [!IMPORTANT]
> Câu “object nó truyền reference” thiếu chính xác. Object không được truyền đi; **reference là giá trị được truyền**. Và vì reference cũng chỉ là một giá trị, Java vẫn là pass-by-value.

## 3. Câu hỏi phỏng vấn

> **Java truyền tham trị hay truyền tham chiếu? Vì sao method có thể sửa `List`/object của người gọi, nhưng lại không thể `swap(a, b)`?**

Đây là câu hỏi rất phổ biến vì nó kiểm tra xem ứng viên có phân biệt được hai thao tác sau không:

1. **Sửa trạng thái của object** mà một reference trỏ tới.
2. **Đổi reference của biến** đang nằm ở phía người gọi.

Java làm được việc thứ nhất. Java không cho method đổi trực tiếp biến local của caller bằng cách gán lại parameter.

## 4. Câu trả lời 30 giây

> Java luôn truyền theo giá trị. Với primitive, Java copy trực tiếp giá trị như `10`. Với object, Java không copy object mà copy **reference** đang trỏ đến object đó. Vì reference gốc và reference trong method cùng trỏ một object, method có thể gọi `setName()`, `add()` hoặc sửa phần tử mảng và caller sẽ thấy thay đổi. Nhưng nếu method gán `param = new Object()`, chỉ parameter cục bộ trỏ sang object mới; biến của caller vẫn trỏ object cũ. Vì vậy Java không phải pass-by-reference và không thể swap hai biến của caller bằng một method thông thường.

## 5. Quy tắc duy nhất: Java copy giá trị

Khi gọi một method, mỗi argument được dùng để khởi tạo parameter tương ứng bằng một phép **copy giá trị**.

| Loại biến truyền vào | Giá trị được copy | Parameter nhận gì? |
|---|---|---|
| Primitive, ví dụ `int` | Con số/boolean/char | Một bản sao độc lập của dữ liệu |
| Reference, ví dụ `User`, `List<User>` | Reference đến object (có thể hình dung như địa chỉ) | Một bản sao độc lập của reference |

`reference` không phải object. Nó là giá trị dùng để xác định object mà biến đang trỏ tới. Đừng nhầm **copy reference** với **truyền biến reference bằng tham chiếu**.

```text
Caller                         Method
------                         ------
int age = 20;                  void f(int value)
                                  value nhận bản sao 20

User user ──ref A──► User      void g(User param)
                                  param nhận bản sao ref A
                                  param ──ref A──► cùng User đó
```

> [!NOTE]
> Hình minh họa stack/heap là mô hình tư duy hữu ích. JVM/JIT có thể tối ưu cách bố trí vật lý, nhưng quy tắc ngôn ngữ không đổi: parameter luôn nhận **bản sao của giá trị argument**. Xem thêm [Heap vs Stack Memory](/fundamentals/heap-vs-stack/).

## 6. Primitive: copy dữ liệu

Với primitive, kết quả rất trực tiếp: đổi parameter không đổi biến gốc.

```java
static void increase(int number) {
    number++;                 // chỉ đổi bản sao trong stack frame của increase
    System.out.println(number);
}

public static void main(String[] args) {
    int score = 10;
    increase(score);
    System.out.println(score);
}
```

Output:

```text
11
10
```

Tại thời điểm gọi `increase(score)`, giá trị `10` được copy vào `number`:

```text
main frame                 increase frame
──────────                 ──────────────
score = 10  ── copy ───►   number = 10
                             number++ → 11

score vẫn là 10
```

## 7. Object: copy reference, không copy object

Giả sử `user` là một biến reference. Nó giữ một giá trị reference trỏ tới object `User`. Khi gọi `change(user)`, Java copy **reference đó** vào `param`.

```text
Trước khi gọi change(user):

main frame                             heap
┌────────────────────┐                 ┌───────────────────────┐
│ user = ref U1      │ ─────────────►  │ User { name = "An" }  │
└────────────────────┘                 └───────────────────────┘

Bên trong change(User param):

main frame             change frame                    heap
┌──────────────┐      ┌───────────────┐                ┌───────────────────────┐
│ user = ref U1│──┐   │ param = ref U1│ ──┐            │ User { name = "An" }  │
└──────────────┘  │   └───────────────┘   │            └───────────────────────┘
                  └───────────────────────┴──────────► cùng một object
```

Hai biến `user` và `param` là hai ô nhớ khác nhau. Chúng chỉ tình cờ chứa cùng một giá trị reference `U1` khi method vừa bắt đầu.

### 7.1 Sửa object: người gọi thấy thay đổi

```java
class User {
    String name;

    User(String name) {
        this.name = name;
    }
}

static void rename(User param) {
    param.name = "Bình";       // sửa field của object mà param trỏ tới
}

public static void main(String[] args) {
    User user = new User("An");
    rename(user);
    System.out.println(user.name);
}
```

Output:

```text
Bình
```

`param.name = "Bình"` không hề gán lại `param`. Nó đi theo `param` tới object chung rồi sửa field `name` bên trong object đó. `user` cũng trỏ tới object ấy nên khi đọc `user.name`, caller thấy dữ liệu mới.

### 7.2 Gán lại tham số: người gọi không thấy thay đổi

```java
static void replace(User param) {
    param = new User("Bình");  // chỉ đổi parameter cục bộ sang reference mới
}

public static void main(String[] args) {
    User user = new User("An");
    replace(user);
    System.out.println(user.name);
}
```

Output:

```text
An
```

Diễn biến:

```text
(1) Trước replace(user)
user  = ref U1 ──► User("An")

(2) Khi vào method: param nhận bản sao ref U1
user  = ref U1 ──► User("An")
param = ref U1 ──► User("An")

(3) param = new User("Bình")
user  = ref U1 ──► User("An")
param = ref U2 ──► User("Bình")

(4) Method return: param biến mất. user chưa từng bị gán lại.
```

> [!IMPORTANT]
> `param = ...` thay đổi **ô parameter** trong frame của method. Nó không thể chạm tới ô `user` trong frame của caller. Đây là bằng chứng quyết định rằng Java không pass-by-reference.

### 7.3 Vì sao không thể swap hai object qua method?

Một cách kiểm tra kinh điển:

```java
static void swap(User first, User second) {
    User temp = first;
    first = second;
    second = temp;
}

public static void main(String[] args) {
    User a = new User("A");
    User b = new User("B");

    swap(a, b);
    System.out.println(a.name + ", " + b.name);
}
```

Output vẫn là:

```text
A, B
```

`swap` chỉ hoán đổi hai **bản sao** `first` và `second`. Nó không thể hoán đổi hai reference `a`, `b` của caller.

```text
Caller trước swap:        Trong swap sau khi đổi local parameter:
a = ref U1 ─► User A      first  = ref U2 ─► User B
b = ref U2 ─► User B      second = ref U1 ─► User A

Caller sau khi return:
a = ref U1 ─► User A      // không đổi
b = ref U2 ─► User B      // không đổi
```

## 8. Pass-by-reference thật sự là gì?

Trong **pass-by-reference thật**, parameter là một alias trực tiếp của biến caller. Do đó gán lại parameter sẽ gán lại chính biến của caller.

Ví dụ C++ dùng reference parameter:

```cpp
void swap(User& first, User& second) {
    User temp = first;
    first = second;
    second = temp;
}
```

`first` và `second` ở đây là alias của biến truyền vào, nên thao tác gán tác động ra bên ngoài method. Java không có cơ chế parameter kiểu này.

| Câu hỏi kiểm tra | Java | Pass-by-reference thật |
|---|---|---|
| Method sửa field của object được không? | Có | Có |
| Method gán lại parameter, caller có đổi không? | Không | Có |
| `swap(a, b)` có đổi được caller không? | Không | Có |

Câu nói chính xác trong Java là: **“Java passes object references by value.”** Không phải “Java pass object by reference”.

## 9. Các bẫy phỏng vấn thường gặp

### 9.1 String và Integer là immutable

Nhiều người chạy ví dụ này rồi kết luận sai rằng object luôn không sửa được qua method:

```java
static void change(String text) {
    text = text + " Java";
}

public static void main(String[] args) {
    String language = "Hello";
    change(language);
    System.out.println(language);
}
```

Output là `Hello`, nhưng có **hai lý do**:

1. `String` là immutable: không thể sửa object `"Hello"` tại chỗ.
2. `text + " Java"` tạo `String` mới rồi gán lại **parameter** `text`.

Điều này không chứng minh object reference “không được truyền”. Nó chỉ là trường hợp **gán lại bản sao reference**.

`Integer` cũng immutable. Lưu ý `count++` thực chất gần tương đương:

```java
count = Integer.valueOf(count.intValue() + 1);
```

Nó tạo/chọn một `Integer` khác và gán lại parameter, nên không đổi biến `Integer` của caller.

### 9.2 Mảng, List và Map vẫn có thể bị sửa

Array, `ArrayList`, `HashMap` là object mutable. Method có thể dùng bản sao reference để sửa nội dung của chúng:

```java
static void update(int[] numbers, java.util.List<String> names) {
    numbers[0] = 99;
    names.add("Bình");
}

public static void main(String[] args) {
    int[] numbers = {1, 2};
    var names = new java.util.ArrayList<String>();

    update(numbers, names);
    System.out.println(numbers[0]); // 99
    System.out.println(names);      // [Bình]
}
```

Nhưng gán `numbers = new int[]{...}` hoặc `names = new ArrayList<>()` bên trong `update` vẫn chỉ đổi parameter cục bộ.

> [!WARNING]
> Đừng lấy việc method sửa được `List` làm bằng chứng Java pass-by-reference. Điều đúng là method nhận **bản sao reference** và dùng nó để sửa **cùng một List object**.

### 9.3 null cũng là một giá trị reference

`null` không có object phía sau, nhưng nó vẫn là một giá trị có thể được copy vào parameter:

```java
static void create(User param) {
    param = new User("An");
}

public static void main(String[] args) {
    User user = null;
    create(user);
    System.out.println(user); // null
}
```

`user` đưa giá trị `null` vào `param`. Gán `param` sang reference mới không quay lại đổi `user`.

## 10. Muốn thay đổi biến của người gọi thì làm thế nào?

Vì method không thể gán lại local variable của caller, API nên biểu đạt ý định rõ ràng.

| Mục tiêu | Cách nên dùng | Ví dụ |
|---|---|---|
| Cập nhật trạng thái object hiện có | Mutate object nếu domain cho phép | `user.rename("Bình")` |
| Thay object bằng object khác | **Return** object mới; caller tự gán | `user = rename(user, "Bình")` |
| Trả nhiều giá trị | Return record/DTO | `return new SwapResult(b, a)` |
| Cần holder có thể mutate | Dùng holder rõ ràng, cân nhắc kỹ | `AtomicReference<T>` trong concurrency |

Ví dụ immutable/functional rõ ràng hơn:

```java
record User(String name) {}

static User rename(User user, String newName) {
    return new User(newName);
}

public static void main(String[] args) {
    User user = new User("An");
    user = rename(user, "Bình"); // caller chủ động đổi reference của mình
}
```

Dùng `User[]`, `AtomicReference<User>` hoặc một holder chỉ để mô phỏng “out parameter” thường làm API khó đọc. Ưu tiên `return` giá trị mới, trừ khi holder là một phần đúng đắn của domain hoặc bài toán đồng thời.

## 11. Câu hỏi đào sâu và câu trả lời mẫu

> **“Nếu Java pass-by-value, tại sao `list.add()` làm list bên ngoài thay đổi?”**

`list` trong method là bản sao của reference. Bản sao này vẫn trỏ tới cùng một `List` object, nên `add()` sửa object chung. Nếu viết `list = new ArrayList<>()`, caller không đổi.

> **“Vậy Java có copy cả object khi gọi method không?”**

Không. Java copy giá trị reference, không clone/copy object. Vì vậy gọi method thường rẻ hơn nhiều so với copy một object lớn; nhưng object vẫn có thể bị thay đổi nếu mutable.

> **“`final` parameter có biến Java thành pass-by-reference không?”**

Không. `final User user` chỉ cấm gán lại parameter `user` trong method. Nó không cấm sửa `user.name` nếu object mutable, và không thay đổi cơ chế truyền tham trị.

```java
static void rename(final User user) {
    // user = new User("Bình"); // lỗi compile
    // user.name = "Bình";     // vẫn hợp lệ nếu User mutable
}
```

> **“Có phải reference là địa chỉ bộ nhớ thật không?”**

Không nên khẳng định như vậy trong câu trả lời chính xác. Ở cấp mô hình ngôn ngữ, reference là giá trị dùng để tham chiếu object. HotSpot có thể dùng compressed oops, GC di chuyển object, và JIT có tối ưu riêng; địa chỉ vật lý không phải phần Java language specification cam kết. Có thể dùng “địa chỉ” như một phép ví von, không phải định nghĩa tuyệt đối.

> **“Có cách nào swap được trong Java không?”**

Có thể trả về kết quả để caller tự gán, hoặc swap phần tử trong một mảng/List mutable. Nhưng không có method thông thường nào hoán đổi trực tiếp hai local variable của caller.

```java
static <T> void swap(java.util.List<T> list, int i, int j) {
    T temp = list.get(i);
    list.set(i, list.get(j));
    list.set(j, temp);
}
```

Ví dụ này swap được vì method sửa **state của List object**, không phải hoán đổi hai variable local của caller.

## 12. Cheat sheet

| Phát biểu | Đúng hay sai? | Lý do |
|---|---|---|
| Java luôn pass-by-value | Đúng | Argument luôn được copy vào parameter |
| Java truyền object bằng reference | Sai/dễ gây hiểu nhầm | Java truyền **bản sao của reference** |
| Method có thể sửa object caller đang giữ | Đúng | Hai reference cùng trỏ một object mutable |
| Method có thể gán lại biến local của caller | Sai | Chỉ gán lại parameter cục bộ |
| `swap(a, b)` đổi được `a`, `b` của caller | Sai | Chỉ swap hai parameter copies |
| `String` không đổi sau method vì Java không truyền object | Sai | `String` immutable và parameter bị reassign |
| `final` parameter làm thành pass-by-reference | Sai | `final` chỉ cấm reassign parameter |

**Công thức trả lời phỏng vấn:**

```text
Java luôn pass-by-value.
Primitive: copy dữ liệu.
Object: copy reference, nên cùng trỏ một object.
Mutate object → caller thấy thay đổi.
Reassign parameter → caller không thấy thay đổi.
Không swap được caller variables → Java không pass-by-reference.
```
