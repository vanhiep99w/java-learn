---
title: "Java Memory Model (JMM) — Deep Dive"
description: "Mổ xẻ JMM: visibility & ordering, happens-before chain, CPU cache coherence (MESI), memory barriers (LoadLoad/StoreStore/LoadStore/StoreLoad), reordering rules, final field semantics, volatile vs synchronized dưới góc nhìn JMM, double-checked locking, và cách JIT/CPU phá vỡ giả định. Kèm ví dụ chạy được, jcstress test, và anti-patterns."
---

## Mục lục

- [Bug "vô hình" — field đã ghi nhưng thread khác đọc thấy 0](#1-bug-vô-hình--field-đã-ghi-nhưng-thread-khác-đọc-thấy-0)
- [JMM là gì — hợp đồng giữa lập trình viên và JVM](#2-jmm-là-gì--hợp-đồng-giữa-lập-trình-viên-và-jvm)
- [Ba thuộc tính nền tảng: Visibility, Ordering, Atomicity](#3-ba-thuộc-tính-nền-tảng-visibility-ordering-atomicity)
- [CPU Cache Coherence — tại sao visibility là vấn đề thực](#4-cpu-cache-coherence--tại-sao-visibility-là-vấn-đề-thực)
- [Reordering — khi compiler và CPU xáo trộn thứ tự](#5-reordering--khi-compiler-và-cpu-xáo-trộn-thứ-tự)
- [Happens-Before — quy tắc vàng của JMM](#6-happens-before--quy-tắc-vàng-của-jmm)
- [Memory Barriers — cách JVM thực thi happens-before](#7-memory-barriers--cách-jvm-thực-thi-happens-before)
- [volatile dưới góc nhìn JMM](#8-volatile-dưới-góc-nhìn-jmm)
- [synchronized dưới góc nhìn JMM](#9-synchronized-dưới-góc-nhìn-jmm)
- [final field semantics — an toàn khi publish object](#10-final-field-semantics--an-toàn-khi-publish-object)
- [Double-Checked Locking — case study kinh điển](#11-double-checked-locking--case-study-kinh-điển)
- [jcstress — chứng minh bug JMM bằng test](#12-jcstress--chứng-minh-bug-jmm-bằng-test)
- [Anti-patterns & Tóm tắt](#13-anti-patterns--tóm-tắt)

---

## 1. Bug "vô hình" — field đã ghi nhưng thread khác đọc thấy 0

Java Memory Model (JMM) là **hợp đồng giữa lập trình viên và JVM** quy định khi nào một ghi từ thread A chắc chắn hiển thị với thread B, và compiler/CPU được phép reorder tới đâu. Không hiểu JMM, bạn sẽ gặp những bug "vô hình" — code đúng về logic, chạy tốt trên máy dev, nhưng production thì thread đọc mãi giá trị cũ. Bắt đầu từ một flag dừng đơn giản.

Bạn viết một flag đơn giản để báo hiệu thread worker dừng lại:

```java
public class Server {
    private boolean running = true;         // không volatile

    public void start() {
        new Thread(() -> {
            while (running) {               // worker thread
                // handle request...
            }
            System.out.println("Stopped");
        }).start();
    }

    public void stop() {
        running = false;                    // main thread
        System.out.println("Flag set to false");
    }
}
```

Trên máy dev (1–2 core, `-Xint` interpreter mode): chạy tốt, worker dừng. Trên production (multi-core, C2 JIT): worker **không bao giờ dừng** — `running` mãi mãi là `true` trong mắt worker thread, dù main thread đã set `false` rồi.

Profiler không giúp gì. Không có exception. Không có deadlock. CPU bình thường. Nhưng worker thread **bị ghim** trong vòng lặp vĩnh viễn.

Nguyên nhân: **JIT hoist** — C2 compiler thấy `running` không thay đổi trong body vòng lặp, nên nó "kéo" việc đọc ra ngoài loop:

```java
// Compiler tối ưu tương đương:
boolean cached = running;     // đọc 1 lần
while (cached) {              // loop mãi mãi
    // ...
}
```

Thêm `volatile` vào `running` → buộc mỗi lần lặp phải đọc lại từ main memory → worker thấy `false` → dừng.

Phần còn lại của doc sẽ đi qua: JMM là gì (§2) → ba thuộc tính visibility/ordering/atomicity (§3) → cache coherence & MESI (§4) → reordering (§5) → happens-before (§6) → memory barriers (§7) → volatile & synchronized dưới góc JMM (§8–§9) → final field (§10) → double-checked locking (§11) → jcstress (§12).

> [!IMPORTANT]
> Bug này **không phải** lỗi logic, không phải race condition kiểu mất update. Nó là **visibility failure** — thread ghi giá trị mới nhưng thread khác không nhìn thấy. JMM tồn tại để quy định chính xác khi nào một ghi từ thread A **đảm bảo** hiển thị với thread B.

---

## 2. JMM là gì — hợp đồng giữa lập trình viên và JVM

**Java Memory Model** (JSR-133, Java 5+) là **specification** quy định:
- Thread A ghi biến `x`, khi nào thread B **chắc chắn** nhìn thấy giá trị mới?
- Compiler / JVM / CPU được phép **xáo trộn** (reorder) thứ tự thực thi tới mức nào?

JMM **không** mô tả kiến trúc phần cứng cụ thể. Nó là **hợp đồng trừu tượng**:

```
┌──────────────────────────────────────────────────────┐
│                   Lập trình viên                     │
│  "Nếu tôi dùng volatile/synchronized/final đúng,     │
│   JVM đảm bảo visibility và ordering cho tôi."       │
├──────────────────────────────────────────────────────┤
│                   JMM (Specification)                │
│  Quy tắc happens-before, final field semantics       │
├──────────────────────────────────────────────────────┤
│              JVM Implementation (HotSpot)            │
│  Chèn memory barrier, cấm JIT reorder vi phạm JMM    │
├──────────────────────────────────────────────────────┤
│                  Hardware (CPU)                      │
│  Mỗi kiến trúc (x86-TSO, ARM-weak) có memory model   │
│  riêng — JVM phải "bù" bằng barrier phù hợp          │
└──────────────────────────────────────────────────────┘
```

> [!NOTE]
> JMM cố tình **lỏng lẻo** (weak) — cho phép JIT và CPU tối ưu tối đa, miễn là chương trình **tuân thủ hợp đồng** (dùng đúng synchronization) thì kết quả vẫn đúng. Nếu bạn **không** tuân thủ (như mục 1), JMM **không hứa** gì — behavior là undefined.

---

## 3. Ba thuộc tính nền tảng: Visibility, Ordering, Atomicity

| Thuộc tính | Ý nghĩa | Ví dụ vi phạm |
|-----------|---------|---------------|
| **Visibility** | Thread B nhìn thấy giá trị mà thread A đã ghi | `running = false` nhưng worker không thấy (mục 1) |
| **Ordering** | Thứ tự các thao tác "nhìn" được từ thread khác | Thread A ghi `data = 42` rồi `ready = true`; thread B thấy `ready = true` nhưng `data` vẫn là 0 |
| **Atomicity** | Thao tác diễn ra nguyên vẹn, không bị xé lẻ | `long x = Long.MAX_VALUE` trên JVM 32-bit: thread khác có thể đọc 32 bit cao mới + 32 bit thấp cũ |

### 3.1. Visibility — cache làm gì mà mất?

Mỗi core CPU có **L1/L2 cache** riêng. Khi thread A ghi `running = false`, giá trị có thể chỉ nằm trong cache của core A. Thread B trên core B vẫn đọc giá trị **cũ** từ cache riêng. Không có lệnh nào buộc core B "nhìn lại" main memory — trừ khi có **memory barrier**.

### 3.2. Ordering — compiler và CPU đều xáo trộn

```java
// Thread A
data = 42;          // (1)
ready = true;       // (2)

// Thread B
if (ready) {        // (3)
    print(data);    // (4) — có thể in 0!
}
```

Compiler có thể đổi thứ tự `(1)` và `(2)` vì chúng **độc lập trong cùng thread**. CPU có thể đổi thứ tự ghi ra bus. Kết quả: thread B thấy `ready = true` (ghi `(2)` tới trước) nhưng `data` chưa tới → đọc 0.

### 3.3. Atomicity — long/double trên 32-bit

JMM **không** đảm bảo ghi/đọc `long` và `double` là atomic trên mọi JVM. Trên JVM 32-bit, một `long` (64-bit) có thể bị tách thành **hai** ghi 32-bit. Thread khác đọc đúng lúc giữa → nhận giá trị **hỗn hợp** (32 bit từ giá trị cũ + 32 bit từ giá trị mới).

> [!WARNING]
> Trên JVM 64-bit hiện đại, ghi `long`/`double` **thường** atomic. Nhưng spec **không** đảm bảo. Nếu cần chắc chắn: dùng `volatile long` hoặc `AtomicLong`.

---

## 4. CPU Cache Coherence — tại sao visibility là vấn đề thực

### 4.1. Kiến trúc cache phân tầng

```
          Core 0              Core 1              Core 2              Core 3
        ┌────────┐          ┌────────┐          ┌────────┐          ┌────────┐
        │ L1 $d  │          │ L1 $d  │          │ L1 $d  │          │ L1 $d  │
        │ L1 $i  │          │ L1 $i  │          │ L1 $i  │          │ L1 $i  │
        └───┬────┘          └───┬────┘          └───┬────┘          └───┬────┘
            │                   │                   │                   │
        ┌───┴────┐          ┌───┴────┐          ┌───┴────┐          ┌───┴────┐
        │  L2 $  │          │  L2 $  │          │  L2 $  │          │  L2 $  │
        └───┬────┘          └───┬────┘          └───┬────┘          └───┬────┘
            └────────┬──────────┴──────────┬────────┘                   │
                 ┌───┴────────────────┐  ┌─┴──────────────────┐         │
                 │     L3 $ (shared)  │  │   L3 $ (shared)    │         │
                 └────────┬───────────┘  └─────────┬──────────┘         │
                          └──────────┬─────────────┘                    │
                                 ┌───┴───┐                              │
                                 │ DRAM  │ ← Main Memory                │
                                 └───────┘
```

### 4.2. MESI protocol — trạng thái cache line

CPU dùng **MESI** (Modified, Exclusive, Shared, Invalid) để giữ coherence giữa các cache:

| Trạng thái | Ý nghĩa | Đọc? | Ghi? |
|-----------|---------|------|------|
| **M** (Modified) | Cache line đã bị sửa, chỉ core này có bản mới nhất | Có | Có |
| **E** (Exclusive) | Chỉ core này cache, nhưng chưa sửa (đồng nhất DRAM) | Có | Có (chuyển sang M) |
| **S** (Shared) | Nhiều core cache cùng giá trị | Có | Không (phải invalidate các core khác trước) |
| **I** (Invalid) | Cache line không hợp lệ, phải đọc lại | Không | Không |

Khi core 0 ghi biến `x` (cache line chuyển sang **M**), nó gửi **invalidate** message trên bus. Core 1 nhận message → đánh dấu cache line của `x` là **I**. Lần đọc tiếp, core 1 phải fetch lại từ L3/DRAM.

### 4.3. Store Buffer & Invalidate Queue — nguồn gốc "trễ" visibility

Vấn đề: gửi invalidate message và đợi **acknowledge** từ các core khác rất **chậm** (hàng chục nanosecond). CPU **không đợi** — nó đẩy ghi vào **Store Buffer** rồi tiếp tục thực thi:

```
Core 0:
  STORE x = 1  → [Store Buffer] → ... → eventually → L1 → bus invalidate → Core 1 ack
  LOAD  y      → đọc ngay từ L1 (không đợi store buffer flush)
```

Hệ quả: từ góc nhìn core 1, ghi `x = 1` có thể **tới sau** ghi `y = 2` dù core 0 ghi `x` trước `y`. Đây chính là **store-store reordering** ở mức phần cứng.

**Invalidate Queue**: khi core 1 nhận invalidate message, thay vì invalidate cache line ngay (chậm), nó đẩy vào queue rồi gửi ack. Khi core 1 đọc `x` lần kế, nó có thể đọc **giá trị cũ** vì invalidate chưa được xử lý. Đây là **load-load/load-store reordering**.

> [!IMPORTANT]
> Memory barrier (fence) **buộc** CPU flush store buffer hoặc xử lý invalidate queue **trước khi tiếp tục**. Đó là cách JVM thực thi happens-before trên phần cứng thực.

---

## 5. Reordering — khi compiler và CPU xáo trộn thứ tự

### 5.1. Ba nguồn reordering

| Nguồn | Cơ chế | Ví dụ |
|-------|--------|-------|
| **Compiler** (javac / JIT C2) | Sắp xếp lại instruction để tối ưu pipeline | Hoán đổi hai ghi độc lập |
| **CPU** (out-of-order execution) | Thực thi instruction không theo thứ tự program | Store Buffer, speculative load |
| **Memory subsystem** | Store Buffer / Invalidate Queue | Ghi tới sau đọc dù ghi trước |

### 5.2. Quy tắc: reorder **trong cùng thread** không làm sai kết quả

JMM đảm bảo **within-thread as-if-serial**: kết quả của **một** thread đơn lẻ luôn đúng như thể chạy tuần tự. Reorder chỉ **lộ** ra khi thread khác quan sát:

```java
// Thread A — compiler có thể đổi (1) ↔ (2)
x = 1;         // (1)
y = 2;         // (2) — không phụ thuộc x → đổi OK trong single-thread

// Thread B — quan sát được "y = 2 nhưng x = 0" nếu (2) tới trước (1)
if (y == 2) {
    assert x == 1;  // CÓ THỂ FAIL
}
```

### 5.3. x86 vs ARM — ai "mạnh" hơn?

| Kiến trúc | Memory Model | Reorder cho phép |
|-----------|-------------|-----------------|
| **x86** (Intel/AMD) | **TSO** (Total Store Order) | Chỉ cho phép **Store-Load** reorder (store buffer) |
| **ARM** / **RISC-V** | **Weak** | Cho phép **mọi loại** reorder (LoadLoad, LoadStore, StoreStore, StoreLoad) |

Vì x86 "mạnh" (ít reorder), nhiều bug JMM **không hiện trên x86** nhưng **nổ tung trên ARM** (server ARM, Android). Đây là bẫy kinh điển: test trên laptop Intel thấy OK, deploy ARM production → crash.

### 5.4. Memory barriers — assembly mapping trên x86 và ARM

JVM translate JMM semantics thành **hardware barriers** tùy kiến trúc:

| JMM barrier | x86 (TSO) | ARM (weak) |
|-------------|-----------|------------|
| LoadLoad | no-op (x86 đảm bảo sẵn) | `dmb ishld` |
| StoreStore | no-op | `dmb ishst` |
| LoadStore | no-op | `dmb ish` |
| **StoreLoad** | **`mfence`** hoặc `lock addl $0, (%rsp)` | `dmb ish` |

```
volatile write trên x86:
  mov [address], value      ; store
  lock addl $0, (%rsp)     ; StoreLoad barrier (flush store buffer)

volatile read trên x86:
  mov reg, [address]        ; load (no barrier needed — TSO guarantees LoadLoad)

volatile write trên ARM:
  dmb ishst                 ; StoreStore barrier
  str value, [address]      ; store
  dmb ish                   ; StoreLoad barrier (full fence)
```

> [!WARNING]
> Đừng bao giờ dựa vào hành vi quan sát được trên một kiến trúc cụ thể. Chỉ dựa vào **JMM spec** — tức happens-before.

---

## 6. Happens-Before — quy tắc vàng của JMM

**Happens-before** (HB) là quan hệ **bắc cầu** giữa các action: nếu action A **happens-before** action B, thì **mọi ghi** trước A **chắc chắn hiển thị** với B.

### 6.1. Các quy tắc HB cốt lõi

| # | Quy tắc | Ý nghĩa |
|---|---------|---------|
| 1 | **Program Order** | Trong cùng thread: mỗi action HB action tiếp theo |
| 2 | **Monitor Lock** | `unlock(m)` HB mọi `lock(m)` **tiếp theo** trên cùng monitor |
| 3 | **volatile Write-Read** | Ghi volatile `v` HB mọi đọc `v` **tiếp theo** |
| 4 | **Thread Start** | `thread.start()` HB mọi action trong thread được start |
| 5 | **Thread Join** | Mọi action trong thread HB `join()` return |
| 6 | **Thread Interrupt** | `thread.interrupt()` HB thread bị interrupt detect được interrupt |
| 7 | **Finalizer** | Constructor kết thúc HB `finalize()` bắt đầu |
| 8 | **Transitivity** | A HB B, B HB C ⇒ A HB C |

### 6.2. Ví dụ áp dụng HB chain

```java
// Thread A
data = 42;               // (a1)
volatile_flag = true;    // (a2) — volatile write

// Thread B
if (volatile_flag) {     // (b1) — volatile read
    print(data);         // (b2) — chắc chắn thấy 42
}
```

Chain: `(a1) →[PO]→ (a2) →[Volatile]→ (b1) →[PO]→ (b2)`

- `(a1)` HB `(a2)` (Program Order)
- `(a2)` HB `(b1)` (Volatile Write → Read)
- Transitivity: `(a1)` HB `(b1)` → ghi `data = 42` **hiển thị** cho `(b2)`

> [!TIP]
> Volatile không chỉ đảm bảo visibility cho **chính** biến volatile, mà cho **tất cả** các ghi trước nó trong thread A. Đây gọi là **piggybacking** — dùng volatile write/read để "kéo theo" visibility cho các biến non-volatile.

### 6.3. Khi **không có** HB → kết quả bất định

```java
// Không có synchronization nào
// Thread A                    // Thread B
x = 1;                         r1 = y;
y = 2;                         r2 = x;
```

Kết quả hợp lệ theo JMM: `(r1, r2)` có thể là `(0, 0)`, `(0, 1)`, `(2, 0)`, `(2, 1)` — **bất kỳ** tổ hợp nào. Ngay cả `(2, 0)` — "thread B thấy y = 2 nhưng x vẫn 0" — hoàn toàn hợp lệ vì **không** có HB relationship giữa hai thread.

---

## 7. Memory Barriers — cách JVM thực thi happens-before

### 7.1. Bốn loại barrier

| Barrier | Ngăn reorder | Mô tả |
|---------|-------------|-------|
| **LoadLoad** | Load₁ ; LoadLoad ; Load₂ | Load₁ phải hoàn tất trước Load₂ |
| **StoreStore** | Store₁ ; StoreStore ; Store₂ | Store₁ phải tới main memory trước Store₂ |
| **LoadStore** | Load₁ ; LoadStore ; Store₂ | Load₁ hoàn tất trước Store₂ tới main memory |
| **StoreLoad** | Store₁ ; StoreLoad ; Load₂ | Store₁ flush xong, Load₂ mới được đọc — **đắt nhất** |

### 7.2. Mapping JMM → barrier (HotSpot on x86)

| Thao tác JMM | Barrier chèn | Ghi chú |
|--------------|-------------|---------|
| volatile **write** | StoreStore **trước** + StoreLoad **sau** | Đảm bảo ghi trước tới trước, đọc sau thấy |
| volatile **read** | LoadLoad + LoadStore **sau** | Đảm bảo đọc xong trước khi load/store tiếp theo |
| `synchronized` enter | LoadLoad + LoadStore (acquire) | Tương tự volatile read |
| `synchronized` exit | StoreStore + StoreLoad (release) | Tương tự volatile write |

Trên x86 (TSO), hầu hết barrier **miễn phí** vì CPU đã đảm bảo LoadLoad, LoadStore, StoreStore. Chỉ **StoreLoad** cần instruction thực: `mfence` hoặc `lock addl $0, (%rsp)`.

Trên ARM (weak model), **mọi** barrier đều cần instruction: `dmb` (Data Memory Barrier).

```
// HotSpot JIT output cho volatile write trên x86:
mov    [rsi+0x10], eax    ; store value
lock addl $0, (%rsp)      ; StoreLoad barrier (mfence equivalent)
```

> [!NOTE]
> `lock addl $0, (%rsp)` là trick kinh điển của HotSpot — rẻ hơn `mfence` trên nhiều microarchitecture. Nó cộng 0 vào stack (no-op về logic) nhưng prefix `lock` buộc flush store buffer.

---

## 8. volatile dưới góc nhìn JMM

### 8.1. Hai đảm bảo

1. **Visibility**: ghi volatile → flush tất cả pending stores; đọc volatile → invalidate cache, đọc fresh.
2. **Ordering**: không reorder qua volatile write/read.

### 8.2. volatile KHÔNG đảm bảo atomicity compound

```java
volatile int count = 0;

// Thread A & B cùng chạy:
count++;  // KHÔNG atomic! Đây là: read → increment → write (3 bước)
```

`count++` trên volatile **vẫn có race condition**: hai thread đọc cùng giá trị 5, cả hai ghi 6 → mất 1 increment. Cần `AtomicInteger` hoặc `synchronized`.

### 8.3. Khi nào volatile là đủ?

| Pattern | volatile đủ? | Giải thích |
|---------|-------------|-----------|
| Flag (stop/ready) | **Có** | Một writer, nhiều reader, giá trị chỉ đi một chiều |
| Publication (publish object) | **Có** | Ghi volatile sau khi khởi tạo object → reader thấy đầy đủ |
| Counter (count++) | **Không** | Read-modify-write → cần Atomic |
| Check-then-act | **Không** | `if (flag) doSomething()` → cần synchronized |

---

## 9. synchronized dưới góc nhìn JMM

### 9.1. Acquire-Release semantics

`synchronized` cung cấp **cả ba** đảm bảo: visibility + ordering + mutual exclusion.

```java
synchronized (lock) {       // ACQUIRE — load barrier
    // critical section     // mọi ghi trước đây từ thread giữ lock → visible
    data = 42;
}                           // RELEASE — store barrier
                            // mọi ghi trong critical section → flush
```

- **Acquire** (enter monitor): như đọc volatile — invalidate cache, thấy tất cả ghi từ thread trước đó release cùng monitor.
- **Release** (exit monitor): như ghi volatile — flush tất cả ghi trong critical section.

### 9.2. Roach Motel — quy tắc reorder của synchronized

Compiler **được phép** dời code **vào** synchronized block (vào "nhà gián") nhưng **không** được dời **ra**:

```java
x = 1;                      // CÓ THỂ bị dời vào trong block
synchronized (lock) {
    y = 2;
}
z = 3;                      // CÓ THỂ bị dời vào trong block

// Tương đương hợp lệ:
synchronized (lock) {
    x = 1;                  // dời vào — OK
    y = 2;
    z = 3;                  // dời vào — OK
}
```

Nhưng **không bao giờ** code bên trong bị dời ra ngoài. Đây là thuộc tính **roach motel** (vào được, ra không).

> [!IMPORTANT]
> Hai thread phải synchronized **trên cùng một monitor** thì HB mới thành lập. `synchronized(lockA)` trong thread 1 và `synchronized(lockB)` trong thread 2 **không** tạo HB nào giữa chúng.

---

## 10. final field semantics — an toàn khi publish object

### 10.1. Đảm bảo của JMM cho final field

Nếu object được construct **đúng** (constructor không để `this` leak), JMM đảm bảo: mọi thread nhìn thấy reference tới object sẽ **chắc chắn** nhìn thấy giá trị final field đã được gán trong constructor — **không cần** volatile hay synchronized.

```java
public class Config {
    private final int timeout;
    private final String host;

    public Config(int timeout, String host) {
        this.timeout = timeout;
        this.host = host;
    }
    // Nếu Config được publish an toàn (vd gán vào volatile field),
    // mọi thread đọc config.timeout sẽ thấy giá trị đúng.
}
```

### 10.2. Freeze action — cơ chế bên dưới

Khi constructor kết thúc, JVM chèn một **freeze action** (tương đương StoreStore barrier) **sau mỗi ghi vào final field**. Điều này ngăn CPU/compiler reorder ghi final field ra sau constructor return.

```
// Pseudo-barrier:
this.timeout = 42;          // ghi final field
[FREEZE / StoreStore]       // barrier
// --- constructor return ---
ref = new Config(42, "host"); // publish reference
```

### 10.3. Khi final field semantics bị PHÁ

```java
public class Broken {
    private final int value;

    public Broken(int v) {
        this.value = v;
        leakySet(this);      // 😱 this LEAK ra ngoài trước constructor xong
    }

    static void leakySet(Broken b) {
        GLOBAL_REF = b;       // thread khác có thể đọc GLOBAL_REF.value = 0
    }
}
```

Nếu `this` escape trước constructor kết thúc, freeze action **chưa chạy** → thread khác có thể thấy `value = 0` (default value). Đây là lý do quy tắc: **KHÔNG bao giờ để `this` escape trong constructor**.

> [!WARNING]
> "this escape" bao gồm: gán `this` vào static field, truyền `this` làm tham số method, tạo inner class (giữ implicit reference tới `this`), register listener với `this` — tất cả trong constructor.

---

## 11. Double-Checked Locking — case study kinh điển

### 11.1. Pattern (sai) trước Java 5

```java
public class Singleton {
    private static Singleton instance;          // KHÔNG volatile

    public static Singleton getInstance() {
        if (instance == null) {                  // (1) first check — no lock
            synchronized (Singleton.class) {
                if (instance == null) {          // (2) second check — under lock
                    instance = new Singleton();  // (3)
                }
            }
        }
        return instance;
    }
}
```

### 11.2. Vì sao sai?

`instance = new Singleton()` gồm 3 bước (bytecode):
1. Allocate memory
2. Gọi constructor (khởi tạo field)
3. Gán reference vào `instance`

Compiler/CPU có thể **đổi thứ tự** bước 2 và 3:
1. Allocate memory
3. Gán reference vào `instance` ← **chưa init xong!**
2. Gọi constructor

Thread B ở bước `(1)` thấy `instance != null` (reference đã gán), return ngay → nhận object **chưa khởi tạo** → NPE hoặc dữ liệu rác.

### 11.3. Fix đúng

```java
// Cách 1: volatile (Java 5+)
private static volatile Singleton instance;
// volatile write tại (3) tạo HB → thread B đọc volatile thấy object đầy đủ

// Cách 2: Holder pattern (lazy, thread-safe, không cần volatile/synchronized)
public class Singleton {
    private Singleton() {}

    private static class Holder {
        static final Singleton INSTANCE = new Singleton();
        // JVM đảm bảo class init chỉ 1 lần, đồng bộ bởi JLS §12.4.2
    }

    public static Singleton getInstance() {
        return Holder.INSTANCE;
    }
}

// Cách 3: enum (Effective Java khuyên dùng)
public enum Singleton {
    INSTANCE;
}
```

> [!TIP]
> **Holder pattern** là cách được ưa chuộng nhất cho singleton lazy init: không cần synchronization ở read path, JVM class loading mechanism đảm bảo thread-safety miễn phí. Enum singleton đơn giản nhất nhưng không cho phép lazy init phức tạp.

---

## 12. jcstress — chứng minh bug JMM bằng test

Unit test bình thường **không** phát hiện được bug JMM vì chúng chạy quá chậm, quá ít iteration, trên một kiến trúc. **jcstress** (Java Concurrency Stress tests) là framework từ OpenJDK chạy **hàng triệu** iteration trên nhiều core để expose race condition.

### 12.1. Test visibility bug từ mục 1

```java
@JCStressTest
@Outcome(id = "0", expect = ACCEPTABLE_INTERESTING, desc = "Visibility failure!")
@Outcome(id = "42", expect = ACCEPTABLE, desc = "Correct")
@State
public class VisibilityTest {
    int data;
    boolean ready;      // non-volatile!

    @Actor
    public void writer() {
        data = 42;
        ready = true;
    }

    @Actor
    public void reader(I_Result r) {
        if (ready) {
            r.r1 = data;   // có thể thấy 0 — visibility failure
        } else {
            r.r1 = -1;     // chưa sẵn sàng, bỏ qua
        }
    }
}
```

Chạy: `java -jar jcstress.jar -t VisibilityTest`

Trên ARM hoặc chạy đủ lâu trên x86, kết quả `0` **sẽ xuất hiện** → chứng minh visibility failure là thật, không phải lý thuyết.

### 12.2. Khi nào dùng jcstress

- Xác nhận rằng một pattern **có** race condition (trước khi fix)
- Xác nhận rằng fix bằng volatile/synchronized **đã** loại bỏ outcome xấu
- Kiểm tra trên ARM/RISC-V khi develop trên x86

> [!NOTE]
> jcstress **không thay thế** code review và reasoning bằng JMM spec. Nó là **công cụ bổ sung**: không phát hiện bug ≠ không có bug (chỉ là chưa trigger). Ngược lại, nếu jcstress phát hiện outcome xấu → chắc chắn có bug.

---

## 13. Anti-patterns & Tóm tắt

### Anti-patterns

| Anti-pattern | Vì sao sai | Sửa |
|--------------|-----------|-----|
| Shared mutable state không synchronization | Visibility + ordering failure | `volatile`, `synchronized`, `Atomic*` |
| `volatile count++` | Không atomic (read-modify-write) | `AtomicInteger.incrementAndGet()` |
| Double-checked locking thiếu volatile | Object chưa init bị publish | Thêm `volatile` hoặc dùng Holder pattern |
| `this` escape trong constructor | Phá vỡ final field semantics | Không truyền `this` ra ngoài constructor |
| Dùng `synchronized(new Object())` | Mỗi thread lock object khác → không mutual exclusion | Lock trên shared instance |
| Test JMM trên x86 rồi assume đúng mọi nơi | x86-TSO mạnh hơn JMM spec, ARM yếu hơn | Dùng jcstress, reason bằng HB |
| "Nó chạy đúng 1 triệu lần → không có bug" | Race condition không deterministic | Prove bằng HB, không bằng observation |

### Tóm tắt — Cheat sheet

```
JMM = Hợp đồng giữa lập trình viên và JVM:
  "Nếu bạn dùng đúng synchronization, tôi đảm bảo visibility + ordering."

1. Không có HB → JVM không hứa gì → behavior undefined
2. HB chain: ProgramOrder → volatile → monitor → thread start/join → transitivity
3. volatile: visibility + ordering, KHÔNG atomicity compound
4. synchronized: visibility + ordering + mutual exclusion (acquire-release)
5. final: an toàn khi publish object (nếu constructor không leak this)
6. Memory barrier: cách JVM thực thi HB trên phần cứng
7. x86 ít reorder (TSO), ARM nhiều reorder (weak) → test trên x86 ≠ đúng
```

| Cần gì | Dùng gì |
|--------|---------|
| Flag đơn giản (1 writer) | `volatile` |
| Counter (read-modify-write) | `AtomicInteger` / `AtomicLong` |
| Multiple fields cần consistent | `synchronized` block |
| Publish immutable object | `final` fields + safe publication |
| Lock-free data structure | `VarHandle` / `Unsafe` (expert only) |

> [!TIP]
> Một câu để nhớ: *Trong thế giới đa luồng, "nó chạy đúng" không phải bằng chứng — happens-before mới là bằng chứng.* Mọi bug concurrency, lần ngược lại, đều quy về thiếu một HB edge nào đó trong chain.
