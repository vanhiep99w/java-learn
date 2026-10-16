---
title: "4 Tính chất OOP"
description: "Mổ xẻ 4 tính chất OOP ở tầng JVM: Encapsulation và bytecode getter/setter, Inheritance & object layout/super constructor chaining, Polymorphism qua invokevirtual + vtable (vptr, itable), Abstraction abstract class vs interface + default method resolution. Kèm sơ đồ, bytecode thật và bẫy thực tế."
---

Lập trình hướng đối tượng trong Java thường được trình bày qua encapsulation, inheritance, polymorphism và abstraction. Bốn khái niệm này mô tả cách quản lý trạng thái, tái sử dụng hành vi và làm việc qua hợp đồng chung.

## Mục lục

- [1. Tổng quan — đâu là 4 tính chất OOP?](#1-tổng-quan--đâu-là-4-tính-chất-oop)
- [2. Tính chất OOP số 1 — Encapsulation (Đóng gói)](#2-tính-chất-oop-số-1--encapsulation-đóng-gói)
  - [2.1. Đóng gói thật sự = bảo vệ bất biến (invariant)](#21-đóng-gói-thật-sự--bảo-vệ-bất-biến-invariant)
  - [2.2. Bẫy "encapsulation rò rỉ" — trả về tham chiếu mutable](#22-bẫy-encapsulation-rò-rỉ--trả-về-tham-chiếu-mutable)
- [3. Tính chất OOP số 2 — Inheritance (Kế thừa)](#3-tính-chất-oop-số-2--inheritance-kế-thừa)
  - [3.1. Object layout — instance và metadata của lớp](#31-object-layout--instance-và-metadata-của-lớp)
  - [3.2. Super constructor chaining — invokespecial](#32-super-constructor-chaining--invokespecial)
  - [3.3. Vì sao Java không đa kế thừa (class)?](#33-vì-sao-java-không-đa-kế-thừa-class)
- [4. Tính chất OOP số 3 — Polymorphism (Đa hình)](#4-tính-chất-oop-số-3--polymorphism-đa-hình)
  - [4.1. Từ lời gọi Java đến `invokevirtual`](#41-từ-lời-gọi-java-đến-invokevirtual)
  - [4.2. Vtable giúp chọn method nhanh như thế nào?](#42-vtable-giúp-chọn-method-nhanh-như-thế-nào)
  - [4.3. Điều gì được dispatch động, điều gì không?](#43-điều-gì-được-dispatch-động-điều-gì-không)
  - [4.4. Interface dùng `invokeinterface`](#44-interface-dùng-invokeinterface)
  - [4.5. JIT có thể bỏ luôn bước tra bảng](#45-jit-có-thể-bỏ-luôn-bước-tra-bảng)
  - [4.6. Tóm tắt luồng dispatch](#46-tóm-tắt-luồng-dispatch)
  - [4.7. Overriding vs Overloading — runtime vs compile-time](#47-overriding-vs-overloading--runtime-vs-compile-time)
- [5. Tính chất OOP số 4 — Abstraction (Trừu tượng)](#5-tính-chất-oop-số-4--abstraction-trừu-tượng)
  - [5.1. Khác biệt cốt lõi](#51-khác-biệt-cốt-lõi)
  - [5.2. Default method & bài toán đa kế thừa hành vi](#52-default-method--bài-toán-đa-kế-thừa-hành-vi)
- [6. So sánh & khi nào dùng cái nào](#6-so-sánh--khi-nào-dùng-cái-nào)
- [7. Anti-patterns cần tránh](#7-anti-patterns-cần-tránh)
- [8. Tóm tắt — Cheat sheet](#8-tóm-tắt--cheat-sheet)

---

## 1. Tổng quan — đâu là 4 tính chất OOP?

OOP có đúng **4 tính chất cốt lõi** trong phạm vi tài liệu này:

| Số | Tính chất | Câu hỏi mà nó trả lời | Ý chính |
|----|-----------|------------------------|---------|
| **1** | **Encapsulation — Đóng gói** | Ai được phép đọc hoặc thay đổi trạng thái? | Giấu state và bảo vệ invariant qua API có kiểm soát |
| **2** | **Inheritance — Kế thừa** | Lớp mới có quan hệ “is-a” với lớp nào? | Lớp con nhận state/hành vi từ lớp cha và có thể mở rộng chúng |
| **3** | **Polymorphism — Đa hình** | Cùng một lời gọi nhưng implementation nào sẽ chạy? | Chọn bản override theo object thật tại runtime |
| **4** | **Abstraction — Trừu tượng** | Người dùng cần biết điều gì và không cần biết điều gì? | Chỉ lộ hợp đồng cần thiết, ẩn chi tiết cài đặt |

Có thể nhớ bằng bốn động từ:

**Encapsulation: bảo vệ** · **Inheritance: kế thừa** · **Polymorphism: chọn hành vi** · **Abstraction: ẩn chi tiết**.

> [!IMPORTANT]
> Bốn phần chính tiếp theo được ghi rõ **“Tính chất OOP số 1”** đến **“Tính chất OOP số 4”**. Overriding và overloading không phải tính chất thứ năm; chúng được giải thích bên trong phần Polymorphism để tránh nhầm lẫn.

Các tính chất này có giá trị khi chúng làm ranh giới thiết kế rõ hơn. Lạm dụng kế thừa hoặc tạo abstraction không có điểm biến đổi thường khiến code khó thay đổi hơn thay vì linh hoạt hơn.

## 2. Tính chất OOP số 1 — Encapsulation (Đóng gói)

**Encapsulation** = che giấu trạng thái nội bộ, chỉ expose hành vi qua interface công khai. Nhưng nói "tạo getter/setter cho mọi field" là **hiểu sai** bản chất.

### 2.1. Đóng gói thật sự = bảo vệ bất biến (invariant)

Một class được đóng gói tốt **không cho phép object rơi vào trạng thái không hợp lệ**:

```java
// Đóng gói TỆ — getter/setter mù quáng, không bảo vệ gì
public class BankAccount {
    private long balance;
    public long getBalance() { return balance; }
    public void setBalance(long b) { this.balance = b; }  // cho phép số âm!
}

// Đóng gói TỐT — bảo vệ invariant "balance >= 0"
public class BankAccount {
    private long balance;
    public long balance() { return balance; }
    public void withdraw(long amount) {
        if (amount <= 0) throw new IllegalArgumentException("amount > 0");
        if (amount > balance) throw new InsufficientFundsException();
        balance -= amount;          // chỉ thay đổi qua hành vi có kiểm soát
    }
}
```

Ở tầng bytecode, `private` được mã hoá bằng **access flag** `ACC_PRIVATE` (0x0002) trong constant pool của field. JVM **kiểm tra flag này lúc link/verify** — truy cập field private từ ngoài class sẽ ném `IllegalAccessError`.

> [!WARNING]
> `private` chỉ là rào ở mức ngôn ngữ + verifier. **Reflection** (`field.setAccessible(true)`) hoặc `Unsafe` có thể xuyên qua. Đóng gói trong Java là *hợp đồng*, không phải *hàng rào an ninh*. Module system (JPMS, Java 9+) với `--illegal-access=deny` mới thật sự chặn được reflection xuyên gói.

### 2.2. Bẫy "encapsulation rò rỉ" — trả về tham chiếu mutable

```java
public class Team {
    private final List<Player> players = new ArrayList<>();
    public List<Player> getPlayers() { return players; }   // 😱 rò rỉ!
}

team.getPlayers().clear();   // người ngoài xoá sạch list nội bộ
```

Field `private` nhưng vẫn bị thao túng vì bạn **trả về tham chiếu tới chính object nội bộ**. Sửa: trả về bản sao phòng thủ hoặc view bất biến.

```java
public List<Player> players() {
    return Collections.unmodifiableList(players);   // hoặc List.copyOf(players)
}
```

---

## 3. Tính chất OOP số 2 — Inheritance (Kế thừa)

**Inheritance** cho phép một class tái sử dụng và mở rộng class khác. Nhưng điều ít người để ý: kế thừa ảnh hưởng tới **bố cục bộ nhớ** của object và **thứ tự khởi tạo**.

### 3.1. Object layout — instance và metadata của lớp

Một instance `Dog extends Animal` chứa cả field kế thừa từ `Animal` và field của `Dog`. Ví dụ khái niệm dưới đây dùng object header kiểu HotSpot 64-bit với compressed class pointers:

```d2 layout="tala" title="3.1. Dog instance và metadata của lớp"
direction: right
instance: "Dog instance trên heap" {
  grid-rows: 4
  grid-columns: 1
  header: "Object header (ví dụ minh họa)\nMark Word: 8 byte (hash, GC age, lock)\nKlass pointer: 4 byte nén"
  inherited: "Field kế thừa từ Animal\nví dụ: name"
  own: "Field khai báo ở Dog\nví dụ: breed"
  padding: "Padding / alignment\ntùy layout thực tế"
}
metadata: "Dog class metadata\nMetaspace: thông tin lớp, vtable"
instance.header -> metadata: "Klass pointer"
```

Upcasting như `Animal a = dog` **không tạo bản sao** và không thay đổi object: biến `a` vẫn trỏ tới chính instance `Dog`. Field kế thừa vẫn thuộc instance đó.

> [!NOTE]
> Đây là sơ đồ thành phần, không phải bản dump offset. [JVMS §2.7](https://docs.oracle.com/javase/specs/jvms/se25/html/jvms-2.html#jvms-2.7) không bắt buộc một cấu trúc object cụ thể. Thứ tự packing, padding và kích thước header phụ thuộc JVM/cấu hình; không nên suy ra rằng mọi field cha luôn chiếm một khối liên tục trước field con.

### 3.2. Super constructor chaining — invokespecial

Constructor con **bắt buộc** gọi constructor cha (ngầm định `super()` nếu bạn không viết). Bytecode của `new Dog()`:

```text
new Dog
dup
invokespecial Dog.<init>()V
```

Trong constructor `Dog.<init>`, lời gọi constructor cha có dạng:

```text
aload_0
invokespecial Animal.<init>()V
```

Với constructor thông thường trong ví dụ này, trình tự là:

```d2 title="3.2. Constructor chaining: Animal trước, Dog sau"
shape: sequence_diagram
caller: Caller
dog: "Dog.<init>"
animal: "Animal.<init>"
caller -> dog: "invokespecial Dog.<init>()"
dog -> animal: "invokespecial Animal.<init>()"
animal -> dog: "Constructor cha hoàn tất" { style.stroke-dash: 3 }
dog -> dog: "Khởi tạo field của Dog\nrồi chạy phần thân constructor"
dog -> caller: "Dog.<init> hoàn tất (void)" { style.stroke-dash: 3 }
```

Constructor không trả về object. `new` tạo instance; `dup` giữ thêm một bản reference trên operand stack trước lời gọi `invokespecial`.

> [!IMPORTANT]
> Constructor cha chạy **trước** khi field của con được khởi tạo. Bẫy kinh điển: gọi method bị override từ trong constructor cha sẽ chạy bản con — nhưng field con **chưa init**:
> ```java
> class A { A() { init(); } void init() {} }
> class B extends A { int x = 10; void init() { System.out.println(x); } }
> new B();   // in ra 0, KHÔNG phải 10 — vì x chưa được gán khi A.<init> chạy
> ```

### 3.3. Vì sao Java không đa kế thừa (class)?

Để tránh **diamond problem**: nếu `D` kế thừa `B` và `C` mà cả hai cùng kế thừa `A`, field `A.x` xuất hiện mấy lần trong layout của `D`? C++ giải quyết bằng virtual inheritance phức tạp. Java chọn đơn giản: **một class chỉ kế thừa một class**, nhưng implement **nhiều interface** (interface không có state nên không có vấn đề layout).

---

## 4. Tính chất OOP số 3 — Polymorphism (Đa hình)

Đừng bắt đầu bằng vtable. Trước hết, chỉ cần nhớ một câu:

> **Kiểu của biến quyết định method nào được phép gọi; kiểu thật của object quyết định bản override nào sẽ chạy.**

Ví dụ:

```java
class Animal {
    String sound() {
        return "?";
    }
}

class Dog extends Animal {
    @Override
    String sound() {
        return "Gâu";
    }
}

class Cat extends Animal {
    @Override
    String sound() {
        return "Meo";
    }
}

Animal animal = new Dog();
System.out.println(animal.sound()); // Gâu

animal = new Cat();
System.out.println(animal.sound()); // Meo
```

Trong câu `Animal animal = new Dog()` có hai kiểu khác nhau:

| Thành phần | Giá trị | Dùng để làm gì? |
|------------|---------|-----------------|
| Kiểu của biến, hay **kiểu tĩnh** | `Animal` | Compiler kiểm tra có được gọi `sound()` hay không |
| Kiểu của object, hay **kiểu runtime** | `Dog` | JVM chọn implementation thực sự sẽ chạy |

Vì `Animal` khai báo `sound()`, câu `animal.sound()` hợp lệ khi compile. Khi chạy, object đang được tham chiếu là `Dog`, nên `Dog.sound()` được gọi. Việc chọn method tại runtime này gọi là **dynamic dispatch**.

### 4.1. Từ lời gọi Java đến `invokevirtual`

Với lời gọi `animal.sound()`, bytecode có dạng rút gọn:

```text
aload_1
invokevirtual Animal.sound:()Ljava/lang/String;
```

Dòng `Animal.sound` trong bytecode dễ gây hiểu nhầm. Nó **không có nghĩa** JVM luôn chạy `Animal.sound()`. `Animal` là lớp mà compiler dùng để xác nhận lời gọi và ghi tham chiếu method vào bytecode.

Khi thực thi `invokevirtual`, có thể hình dung JVM làm bốn bước:

1. Lấy tham chiếu `animal` trên operand stack.
2. Kiểm tra object thật mà tham chiếu đang trỏ tới — ví dụ `Dog`.
3. Tìm implementation cụ thể nhất của `sound()` cho `Dog`.
4. Chạy `Dog.sound()`.

```d2 title="4.1. Từ lời gọi Java đến invokevirtual"
direction: right
compile: "Compile-time (Animal)\nanimal.sound() hợp lệ\ninvokevirtual Animal.sound"
runtime: "Object thật là lớp nào?" { shape: diamond }
dog: "Dog.sound()"
cat: "Cat.sound()"
compile -> runtime
runtime -> dog: Dog
runtime -> cat: Cat
```

> [!IMPORTANT]
> `Animal` quyết định **có được gọi** `sound()`; `Dog` hoặc `Cat` quyết định **bản nào chạy**. Đây là ý nghĩa cốt lõi của polymorphism trong ví dụ này.

### 4.2. Vtable giúp chọn method nhanh như thế nào?

Nếu mỗi lần gọi JVM phải tìm method theo tên từ `Dog` lên `Animal` rồi lên `Object`, dispatch sẽ tốn kém. JVM thường tổ chức các virtual method thành một bảng gọi là **vtable** (*virtual method table*).

Hãy coi mỗi method là một ô có số thứ tự cố định:

| Vtable slot | `Animal` | `Dog` | `Cat` |
|-------------|----------|-------|-------|
| `sound()` | `Animal.sound` | `Dog.sound` | `Cat.sound` |
| `describe()` | `Animal.describe` | `Animal.describe` | `Animal.describe` |

Khi lớp con override một method, nó **thay địa chỉ method ở cùng slot**:

- `Dog` override `sound()` → slot `sound` trỏ tới `Dog.sound`.
- `Dog` không override `describe()` → slot `describe` vẫn trỏ tới `Animal.describe`.

Object `Dog` chứa thông tin để JVM biết nó thuộc lớp `Dog`. Từ metadata của lớp, JVM có thể đến vtable và lấy đúng slot:

```d2 title="4.2. Vtable giúp chọn method nhanh như thế nào?"
direction: right
animal: "Reference animal"
object: "Dog instance"
vtable: "Dog class metadata\nvtable: sound → Dog.sound"
animal -> object
object -> vtable: "class metadata"
```

Do đó có thể ghi nhớ `invokevirtual` theo mô hình đơn giản sau:

**Object thật → metadata lớp thật → slot method trong vtable → implementation cần chạy.**

> [!NOTE]
> JVM Specification quy định **kết quả của method lookup**, không bắt buộc JVM phải cài đặt bằng vtable. Vtable là mô hình triển khai phổ biến trong HotSpot và là cách trực quan để hiểu dispatch.

### 4.3. Điều gì được dispatch động, điều gì không?

Dynamic dispatch áp dụng cho **instance method có thể override**. Nó không áp dụng giống vậy cho field và `static` method:

```java
class Animal {
    String label = "Animal";

    static String kind() {
        return "Animal";
    }

    String sound() {
        return "?";
    }
}

class Dog extends Animal {
    String label = "Dog";

    static String kind() {
        return "Dog";
    }

    @Override
    String sound() {
        return "Gâu";
    }
}

Animal animal = new Dog();

System.out.println(animal.label);   // Animal
System.out.println(animal.kind());  // Animal — hợp lệ nhưng không nên viết
System.out.println(animal.sound()); // Gâu
```

| Thành phần | Cách chọn | Kết quả trong ví dụ |
|------------|-----------|---------------------|
| Instance method override | Theo kiểu runtime của object | `Dog.sound()` |
| Field | Theo kiểu tĩnh của biến | `Animal.label` |
| `static` method | Theo kiểu tĩnh tại compile-time | `Animal.kind()` |

Field chỉ bị **che** (*field hiding*), còn `static` method chỉ bị **ẩn** (*method hiding*), không override theo nghĩa đa hình. `animal.kind()` được compiler hiểu như `Animal.kind()`, không dispatch sang `Dog.kind()`. Vì vậy nên viết trực tiếp `Animal.kind()` để tránh gây hiểu nhầm.

### 4.4. Interface dùng `invokeinterface`

Cùng một nguyên tắc cũng áp dụng khi biến có kiểu interface:

```java
interface Speaker {
    String sound();
}

class Dog implements Speaker {
    @Override
    public String sound() {
        return "Gâu";
    }
}

Speaker speaker = new Dog();
speaker.sound(); // chạy Dog.sound()
```

Bytecode thường dùng `invokeinterface` thay vì `invokevirtual`. JVM phải tìm implementation của method interface trong lớp thật; HotSpot có thể dùng cấu trúc như **itable** (*interface method table*) và các cache hỗ trợ dispatch.

Điểm cần nhớ không đổi:

```d2 title="4.4. Interface contract và implementation runtime"
grid-rows: 1
grid-columns: 3
horizontal-gap: 48
contract: "Compile-time\nSpeaker khai báo sound()"
instruction: "Bytecode\ninvokeinterface Speaker.sound"
target: "Runtime: object Dog\nchạy Dog.sound()"
contract -> instruction -> target
```

### 4.5. JIT có thể bỏ luôn bước tra bảng

Sau một thời gian chạy, JIT quan sát kiểu object xuất hiện tại từng call site:

- Chỉ gặp `Dog` (**monomorphic**) → JIT có thể inline trực tiếp `Dog.sound()`.
- Thường gặp `Dog` và `Cat` (**bimorphic**) → JIT có thể tạo vài phép kiểm tra kiểu nhanh rồi inline.
- Gặp quá nhiều kiểu (**megamorphic**) → thường phải giữ lời gọi gián tiếp.

Vì vậy vtable giải thích đúng **ngữ nghĩa dispatch**, nhưng code máy sau khi JIT tối ưu không nhất thiết còn thực hiện một lần tra vtable ở mọi lời gọi.

> [!TIP]
> Dùng `final` khi thiết kế yêu cầu class hoặc method không được override. Ngoài việc thể hiện ý định rõ ràng, nó còn làm đích gọi dễ xác định hơn; tuy nhiên JIT cũng có thể tự khử dispatch dựa trên dữ liệu profiling mà không cần `final`.

### 4.6. Tóm tắt luồng dispatch

Với `Animal animal = new Dog(); animal.sound();`, ba giai đoạn đầu giữ nguyên ngữ nghĩa gọi method. JIT có thể tối ưu cách thực hiện ở giai đoạn sau:

```d2 title="4.6. Compile-time, runtime và tối ưu JIT"
grid-rows: 2
grid-columns: 2
horizontal-gap: 64
vertical-gap: 48
compile: "1. Compile-time\nAnimal khai báo sound(): hợp lệ"
bytecode: "2. Bytecode\ninvokevirtual Animal.sound"
jit: "4. JIT (nếu đủ điều kiện)\nCó thể inline Dog.sound()"
runtime: "3. Runtime: object Dog\nChọn Dog.sound()"
compile -> bytecode -> runtime -> jit
```

Nếu chỉ nhớ một dòng, hãy nhớ:

**Kiểu biến kiểm tra lời gọi; kiểu object chọn bản override.**

### 4.7. Overriding vs Overloading — runtime vs compile-time

Hai khái niệm dễ nhầm vì tên giống nhau, nhưng được giải quyết ở **hai thời điểm khác nhau**:

| Tiêu chí | Overriding (ghi đè) | Overloading (nạp chồng) |
|----------|---------------------|--------------------------|
| Quan hệ | Cùng signature, lớp con vs cha | Cùng tên, **khác** tham số |
| Quyết định ở | **Runtime** (dynamic dispatch) | **Compile-time** (kiểu tĩnh) |
| Bytecode | vtable slot phụ thuộc object thật | compiler chọn sẵn method cụ thể |
| Polymorphism? | Có (đa hình thực) | Không (chỉ là cú pháp tiện) |

Bẫy overloading + `null`:

```java
void f(String s) {}
void f(Object o) {}
f(null);   // gọi f(String) — compiler chọn signature CỤ THỂ nhất, lúc biên dịch
```

Bẫy overloading + autoboxing — compiler ưu tiên: **widening > boxing > varargs**:

```java
void g(long x) {}
void g(Integer x) {}
g(1);   // gọi g(long) — widening int→long được ưu tiên hơn boxing int→Integer
```

> [!WARNING]
> Overloading **không** là đa hình. `List<Object> list` chứa `Dog`, gọi `process(list.get(0))` với `process(Dog)`/`process(Cat)` overload → luôn chọn theo kiểu tĩnh `Object`, **không** theo object thật. Muốn dispatch theo kiểu thật giữa nhiều loại, dùng overriding hoặc pattern matching (Java 21).

---

## 5. Tính chất OOP số 4 — Abstraction (Trừu tượng)

**Abstraction** = lộ "cái gì làm được" (hành vi), giấu "làm thế nào" (cài đặt). Java có 2 công cụ: `abstract class` và `interface`.

### 5.1. Khác biệt cốt lõi

| | `abstract class` | `interface` |
|---|------------------|-------------|
| State (field instance) | Có | Không (chỉ `static final`) |
| Constructor | Có | Không |
| Đa kế thừa | Không (1 class) | Có (nhiều interface) |
| Method có thân | Có (cả non-abstract) | `default` / `static` / `private` (Java 8/9+) |
| Dùng khi | "is-a" + chia sẻ state/code | "can-do" + hợp đồng hành vi |

### 5.2. Default method & bài toán đa kế thừa hành vi

Java 8 thêm `default` method vào interface → tái xuất hiện **diamond problem** ở mức hành vi. Nếu hai interface có cùng default method, lớp implement **bắt buộc** phải override để khử mơ hồ:

```java
interface A { default String hi() { return "A"; } }
interface B { default String hi() { return "B"; } }
class C implements A, B {
    @Override public String hi() {
        return A.super.hi();   // chỉ định rõ muốn dùng default của A
    }
}
```

Quy tắc giải quyết của compiler (theo thứ tự ưu tiên):

1. **Class luôn thắng** — method trong class (hoặc cha) > default method.
2. **Interface cụ thể hơn thắng** — `B extends A`, default của `B` > của `A`.
3. Còn lại → mơ hồ → **bắt buộc override**.

```d2 title="5.2. Default method & bài toán đa kế thừa hành vi"
direction: down
n_Call: "gọi obj.hi()"
n_C1: "class/superclass\ncó hi() ?" { shape: diamond }
n_UseClass: "dùng bản của class"
n_C2: "interface nào\ncụ thể hơn ?" { shape: diamond }
n_UseSpecific: "dùng default cụ thể nhất"
n_Force: "lỗi compile → buộc override"
n_Call -> n_C1
n_C1 -> n_UseClass: "có"
n_C1 -> n_C2: "không"
n_C2 -> n_UseSpecific: "có"
n_C2 -> n_Force: "mơ hồ"
```

> [!NOTE]
> `default` method sinh ra để **tiến hoá interface mà không phá vỡ code cũ** (vd thêm `stream()` vào `Collection`). Đừng lạm dụng nó như "trait có state" — interface vẫn không có field instance.

---

## 6. So sánh & khi nào dùng cái nào

| Tình huống | Chọn | Lý do |
|------------|------|-------|
| Nhiều lớp chia sẻ **state + code** chung | `abstract class` | interface không có field |
| Chỉ cần định nghĩa **hợp đồng** | `interface` | nhẹ, đa kế thừa |
| Object cần **nhiều "vai trò"** | nhiều `interface` | `Comparable` + `Serializable` + ... |
| Muốn thêm method vào interface đã publish | `default` method | không phá code client |
| Hành vi thay đổi theo runtime type | overriding (polymorphism) | dynamic dispatch |
| Nhiều cách gọi cùng một thao tác | overloading | tiện cú pháp, không phải đa hình |

**Nguyên tắc thực dụng:** ưu tiên `interface` cho API public (dễ tiến hoá, dễ mock test), dùng `abstract class` khi thật sự cần chia sẻ state/implementation.

---

## 7. Anti-patterns cần tránh

| Anti-pattern | Vì sao sai | Thay bằng |
|--------------|-----------|-----------|
| Getter/setter cho mọi field | Phá đóng gói, không bảo vệ invariant | Expose hành vi, không expose state |
| Trả về collection nội bộ trực tiếp | Người ngoài sửa được state private | `List.copyOf` / `unmodifiableList` |
| Gọi method override trong constructor cha | Field con chưa init → NPE/giá trị 0 | Khởi tạo xong rồi mới gọi |
| Kế thừa để tái sử dụng code (không "is-a") | Vỡ Liskov, coupling chặt | Composition (delegate) |
| Lạm dụng overloading gây mơ hồ | `null`/autoboxing chọn sai overload | Đặt tên method khác nhau |
| `abstract class` chỉ để chứa hằng số | Không có state thật | `interface` hoặc class util |

> [!TIP]
> "Favor composition over inheritance" — kế thừa tạo coupling cứng giữa cha-con, lớp cha đổi là con vỡ. Composition (chứa object khác và uỷ quyền) linh hoạt hơn và tránh phần lớn vấn đề của 4 tính chất.

---

## 8. Tóm tắt — Cheat sheet

**4 tính chất ↔ cơ chế JVM:**

| Tính chất | Cơ chế JVM liên quan |
|---|---|
| Encapsulation | Access control (`ACC_PRIVATE`) và kiểm tra truy cập; API bảo vệ invariant. |
| Inheritance | Instance chứa field kế thừa; `invokespecial` gọi constructor cha. |
| Polymorphism | `invokevirtual` / `invokeinterface`; HotSpot có thể dùng vtable / itable và JIT có thể tối ưu dispatch. |
| Abstraction | Abstract method không có thân; compiler áp dụng quy tắc giải quyết default method. |

| Khái niệm | Thời điểm quyết định | Cơ chế |
|-----------|---------------------|--------|
| Overriding | Runtime | vtable lookup theo object thật |
| Overloading | Compile-time | chọn signature theo kiểu tĩnh |
| default method conflict | Compile-time | class wins → specific wins → buộc override |

**5 nguyên tắc khắc cốt:**

1. **Đóng gói = bảo vệ bất biến**, không phải sinh getter/setter máy móc.
2. **Constructor cha chạy trước** — đừng gọi method ảo trong đó.
3. **Overriding = runtime, overloading = compile-time** — đừng nhầm lẫn.
4. **invokevirtual chọn method theo object thật**, không theo kiểu biến.
5. **Composition > Inheritance** khi quan hệ không thật sự là "is-a".

> [!TIP]
> Một câu để nhớ: **Encapsulation bảo vệ state; Inheritance tạo quan hệ cha–con; Polymorphism chọn hành vi theo object thật; Abstraction chỉ lộ hợp đồng cần thiết.**
