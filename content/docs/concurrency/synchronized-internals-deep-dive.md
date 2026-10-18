---
title: "Synchronized Internals"
description: "Mổ xẻ synchronized trong JVM: Object header mark word, lock escalation (biased → thin/lightweight → heavyweight/fat lock), monitor enter/exit, ObjectMonitor C++ struct, wait/notify internals, lock coarsening & elimination. Kèm đọc HotSpot source và sơ đồ chi tiết."
---

`synchronized` cung cấp mutual exclusion và thiết lập quan hệ happens-before giữa các thread đi qua cùng monitor. Để hiểu chi phí và hành vi của nó, cần nhìn vào object header, monitor và các trạng thái khóa mà JVM quản lý.

## Mục lục

- [Tổng quan](#1-tổng-quan)
- [Object Header — Mark Word chứa lock state](#2-object-header--mark-word-chứa-lock-state)
- [Lock Escalation — 4 cấp độ lock](#3-lock-escalation--4-cấp-độ-lock)
- [Biased Locking — lock "miễn phí" cho single thread](#4-biased-locking--lock-miễn-phí-cho-single-thread)
- [Thin Lock (Lightweight) — CAS trên mark word](#5-thin-lock-lightweight--cas-trên-mark-word)
- [Fat Lock (Heavyweight) — ObjectMonitor và OS mutex](#6-fat-lock-heavyweight--objectmonitor-và-os-mutex)
- [Monitor Enter/Exit — bytecode và JVM implementation](#7-monitor-enterExit--bytecode-và-jvm-implementation)
- [wait() / notify() / notifyAll() — WaitSet internals](#8-wait--notify--notifyall--waitset-internals)
- [Lock Coarsening — JIT gộp nhiều lock liên tiếp](#9-lock-coarsening--jit-gộp-nhiều-lock-liên-tiếp)
- [Lock Elimination — JIT xoá lock không cần thiết](#10-lock-elimination--jit-xoá-lock-không-cần-thiết)
- [Adaptive Spinning — spin trước khi park](#11-adaptive-spinning--spin-trước-khi-park)
- [synchronized vs ReentrantLock — khi nào dùng gì](#12-synchronized-vs-reentrantlock--khi-nào-dùng-gì)
- [Tóm tắt — Cheat sheet & 5 nguyên tắc](#13-tóm-tắt--cheat-sheet--5-nguyên-tắc)

---

## 1. Tổng quan

Mỗi object Java có thể đóng vai trò monitor. JVM lưu thông tin liên quan đến lock trong Mark Word và chuyển chiến lược thực thi theo mức contention; khi không thể xử lý bằng đường nhanh, thread có thể phải park và chờ monitor.

Chi phí không chỉ đến từ cú pháp `synchronized`, mà chủ yếu từ phạm vi khóa, thời gian giữ khóa và số thread cạnh tranh. Vì vậy tối ưu đúng thường bắt đầu từ thiết kế critical section thay vì loại bỏ khóa một cách máy móc.

## 2. Object Header — Mark Word chứa lock state

Mỗi Java object trên heap bắt đầu bằng **Object Header**:

```d2 title="Object header với compressed oops"
direction: right
header: "Object Header: 96 bits\n64-bit JVM, compressed oops" {
  mark: "Mark Word: 64 bits\nlock state, hashCode, GC age, …"
  klass: "Klass Ptr: 32 bits"
}
```

**Mark Word layout** — thay đổi tuỳ lock state:

| Lock State | Bit Pattern (64-bit) | Nội dung |
|-----------|---------------------|----------|
| **Unlocked** (normal) | `[hashCode:31][age:4][biased:0][01]` | Identity hash, GC age |
| **Biased** | `[threadID:54][epoch:2][age:4][biased:1][01]` | Thread owner, bias epoch |
| **Thin Lock** (lightweight) | `[lock_record_ptr:62][00]` | Pointer to Lock Record on stack |
| **Fat Lock** (heavyweight) | `[monitor_ptr:62][10]` | Pointer to ObjectMonitor |
| **GC marked** | `[forwarding_addr:62][11]` | Used during GC |

> [!NOTE]
> Lock tag ở 2 bit cuối: `01` = unlocked/biased, `00` = thin lock, `10` = fat lock. JVM nhìn 2 bit cuối để biết ngay object đang ở trạng thái lock nào — O(1) check.

---

## 3. Lock Escalation — 4 cấp độ lock

```d2 title="3. Lock Escalation — 4 cấp độ lock"
direction: right
n_A: "No Lock"
n_B: "Biased Lock"
n_C: "Thin Lock\n(Lightweight)"
n_D: "Fat Lock\n(Heavyweight)"
n_A -> n_B
n_B -> n_C
n_C -> n_D
n_B -> n_C: "Thread khác\ncố acquire" { style.stroke-dash: 3 }
n_C -> n_D: "CAS fail nhiều lần\n(spin exhausted)" { style.stroke-dash: 3 }
```

| Cấp | Chi phí | Khi nào | Mechanism |
|-----|---------|---------|-----------|
| **Biased** | ~0 (1 CMP instruction) | 1 thread duy nhất acquire lặp lại | ThreadID trong mark word |
| **Thin** | CAS (vài ns) | 2+ thread acquire nhưng **không cùng lúc** | Lock Record trên stack |
| **Fat** | OS mutex (µs range) | 2+ thread **đồng thời** contend | ObjectMonitor + park/unpark |

> [!IMPORTANT]
> Lock **chỉ escalate, không de-escalate** (trong lifecycle của 1 lần monitor enter). Fat lock không tự hạ xuống thin. Nhưng sau khi TẤT CẢ thread release, object CÓ THỂ rebias hoặc trở lại unlocked ở lần acquire sau (tuỳ JVM strategy).

---

## 4. Biased Locking — lock "miễn phí" cho single thread

**Ý tưởng**: đa số lock trong thực tế chỉ được acquire bởi **1 thread** (VD: khởi tạo, single-threaded phase). Biased lock "nhớ" thread đầu tiên — lần acquire tiếp theo chỉ cần **check threadID trong mark word** (1 compare), không cần CAS.

```d2 title="Biased locking: acquire đầu và lần sau"
direction: down
n0: "Lần đầu acquire (bias)\nMark Word: threadID=T1, epoch, age, 1, 01"
n1: "CAS ghi threadID một lần"
n2: "T1 acquire lại: threadID == T1?"
n3: "Đúng: enter\nkhông CAS, không atomic op\n≈ 1 memory read + 1 compare (~1 ns trong ví dụ cũ)"
n0 -> n1
n1 -> n2
n2 -> n3
```

**Revoke biased lock** (khi thread khác muốn acquire):
1. Đợi **safepoint** (global pause) — thread bias holder dừng tại safe point.
2. Kiểm tra T1 có còn đang trong synchronized block?
   - Nếu **không** → revoke bias, set mark word về unlocked/thin.
   - Nếu **có** → inflate thẳng lên thin/fat lock.

> [!WARNING]
> **JDK 15 deprecate Biased Locking** (`-XX:-UseBiasedLocking` default OFF từ JDK 18). Lý do: safepoint-based revocation gây latency spike, và modern workload ít có pure single-thread lock pattern. Thin lock với CAS đã đủ nhanh trên hardware hiện đại.

---

## 5. Thin Lock (Lightweight) — CAS trên mark word

Khi có **2 thread** (nhưng không đồng thời contend), biased lock bị revoke → escalate thành **thin lock**:

### 5.1. Lock Record

JVM tạo **Lock Record** trên stack frame của thread đang acquire:

```d2 title="5.1. Lock Record"
stack: "Thread T1 stack" {
  record: "Lock Record" {
    mark: "displaced mark: backup mark word gốc"
    ref: "obj reference"
  }
}
object: "Object bị lock"
stack.record.ref -> object
```

### 5.2. Acquire flow

```java
// Pseudo-code:
Lock Record lr = allocate_on_stack();
lr.displaced_mark = obj.mark_word;    // backup mark word gốc
lr.obj = obj;

// CAS: swap mark word thành pointer tới Lock Record
if (CAS(obj.mark_word, lr.displaced_mark, ptr_to_lr | 00)) {
    // Thành công! Lock acquired (thin)
} else {
    // CAS fail → có thread khác đã lock
    // Spin một số lần → nếu vẫn fail → inflate lên fat lock
}
```

### 5.3. Release flow

```java
// CAS: swap mark word ngược lại (restore displaced mark)
if (CAS(obj.mark_word, ptr_to_lr, lr.displaced_mark)) {
    // Thành công! Unlock (thin → unlocked)
} else {
    // Mark word đã bị thay đổi (inflated lên fat) → phải release fat lock
    slow_exit(obj);
}
```

> [!TIP]
> Thin lock cost = 1 CAS acquire + 1 CAS release = **~10-20 ns** (no contention). Nhanh hơn 100x so với fat lock (OS mutex). Khi lock "luân phiên" giữa thread (thread A lock → unlock → thread B lock) mà không đồng thời, thin lock vẫn đủ.

---

## 6. Fat Lock (Heavyweight) — ObjectMonitor và OS mutex

Khi thin lock CAS fail nhiều lần (spin exhausted hoặc nhiều thread cùng lúc) → **inflate** thành fat lock. JVM tạo `ObjectMonitor` (C++ struct trong HotSpot):

```cpp
// hotspot/src/share/vm/runtime/objectMonitor.hpp (simplified)
class ObjectMonitor {
    volatile markWord _header;       // displaced mark word (gốc)
    volatile intptr_t _owner;        // thread đang giữ lock (hoặc NULL)
    volatile int _recursions;        // reentrant count
    ObjectWaiter* volatile _EntryList; // thread đang cố acquire (blocked)
    ObjectWaiter* volatile _cxq;      // contention queue (newly blocked)
    ObjectWaiter* volatile _WaitSet;  // thread gọi wait() (waiting)
    volatile int _Spinlock;
    volatile int _SpinDuration;      // adaptive spin count
};
```

```d2 title="6. Fat Lock (Heavyweight) — ObjectMonitor và OS mutex"
direction: right
mark: "Object Mark Word: ObjectMonitor* | 10"
monitor: ObjectMonitor {
  owner: "_owner = Thread T1 (giữ lock)"
  recursion: "_recursions = 0"
  entry: "_EntryList: T2 → T3 → null\n(chờ acquire)"
  wait: "_WaitSet: T4 → null\n(đã gọi wait())"
  cxq: "_cxq: T5 → null\n(mới bị block)"
}
mark -> monitor
```

### 6.1. Enter (acquire fat lock)

```d2 title="ObjectMonitor: acquire, reentrant, spin và park"
direction: down
n0: "CAS _owner NULL → current_thread"
n1: "Lock acquired"
n2: "Contention: _owner == current_thread?"
n3: "Reentrant: _recursions++"
n4: "Adaptive spin: CAS thêm vài lần"
n5: "Spin thành công: tránh park (user-space)"
n6: "Spin exhausted: enqueue _cxq, park (OS)\nRUNNABLE → BLOCKED\ncontext switch ~5–15 µs (ước lượng)"
n0 -> n1: "thành công"
n0 -> n2: "thất bại"
n2 -> n3: "đúng"
n2 -> n4: "khác owner"
n4 -> n5: "thành công"
n4 -> n6: "hết lượt"
```

### 6.2. Exit (release fat lock)

```d2 title="ObjectMonitor: release và đánh thức successor"
direction: down
n0: "_recursions > 0?"
n1: "_recursions--\nvẫn giữ lock"
n2: "_recursions == 0\n_owner = NULL"
n3: "Chọn successor từ _EntryList hoặc _cxq\nunpark"
n4: "Successor thức dậy\nthử CAS _owner để acquire lại"
n0 -> n1: "đúng"
n0 -> n2: "không"
n2 -> n3
n3 -> n4
```

> [!IMPORTANT]
> Fat lock = **OS mutex** dưới hood (`pthread_mutex` trên Linux, `CRITICAL_SECTION` trên Windows). Cost: park/unpark ≈ 2 context switch ≈ **10-30 µs**. So với thin lock (10-20 ns) → chênh lệch **1000×**. Đó là lý do JVM cố hết sức giữ ở thin/biased.

---

## 7. Monitor Enter/Exit — bytecode và JVM implementation

### 7.1. synchronized method

```java
public synchronized void doWork() { ... }
// Bytecode: ACC_SYNCHRONIZED flag trên method
// JVM: acquire monitor trước khi enter method body, release khi return/throw
```

### 7.2. synchronized block

```java
synchronized (obj) {
    // critical section
}
// Bytecode:
//   monitorenter    ← acquire
//   ... code ...
//   monitorexit     ← release (normal path)
//   monitorexit     ← release (exception path — compiler sinh thêm)
```

```
javap output:
  3: aload_1
  4: dup
  5: astore_2
  6: monitorenter          ← enter
  7: ... (body) ...
  14: aload_2
  15: monitorexit           ← exit (normal)
  16: goto 24
  19: astore_3             ← exception handler
  20: aload_2
  21: monitorexit           ← exit (exception) — đảm bảo unlock
  22: aload_3
  23: athrow
```

> [!NOTE]
> Compiler sinh **2 monitorexit** — một cho normal return, một cho exception path. Đảm bảo lock **luôn** được release kể cả khi throw exception. Đây là advantage so với manual lock (`ReentrantLock.unlock()` trong finally).

---

## 8. wait() / notify() / notifyAll() — WaitSet internals

`Object.wait()` và `notify()` chỉ gọi được khi **đang giữ monitor** (trong synchronized block/method):

### 8.1. wait()

```d2 title="wait: nhả monitor, chờ và reacquire"
grid-rows: 4
grid-columns: 2
n0: "T1 đang giữ monitor"
n1: "Tạo ObjectWaiter → enqueue _WaitSet"
n3: "Park → WAITING"
n2: "Release monitor\n_owner=NULL, lưu _recursions"
n4: "Được notify: _WaitSet → _EntryList"
n5: "Re-acquire monitor (có thể phải đợi)"
n7: "" {style.opacity: 0}
n6: "Restore _recursions\ntiếp tục sau wait()"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
n4 -> n5
n5 -> n6
```

### 8.2. notify()

```d2 title="notify không trao lock ngay"
direction: down
n0: "T2 giữ monitor, gọi notify()"
n1: "Lấy một node _WaitSet\nđầu/cuối tùy JVM"
n2: "Chuyển node sang _EntryList hoặc _cxq"
n3: "Chưa unpark ngay\nchỉ eligible để compete lock"
n4: "T2 exit monitor"
n5: "Successor (có thể node vừa notify) được unpark"
n0 -> n1
n1 -> n2
n2 -> n3
n3 -> n4
n4 -> n5
```

### 8.3. notifyAll()

```d2 title="notifyAll chuyển toàn bộ waiter sang cạnh tranh lock"
direction: down
n0: "TẤT CẢ node _WaitSet → _EntryList"
n1: "Monitor được release"
n2: "Tất cả compete lock"
n3: "Chỉ một thread thắng\ncác thread còn lại block lại"
n0 -> n1
n1 -> n2
n2 -> n3
```

> [!WARNING]
> **Spurious wakeup**: Thread có thể thoát `wait()` mà **không** được notify (do OS scheduling). Luôn dùng `while` loop check condition:
> ```java
> synchronized (lock) {
>     while (!condition) {    // WHILE, không phải IF
>         lock.wait();
>     }
> }
> ```

---

## 9. Lock Coarsening — JIT gộp nhiều lock liên tiếp

JIT compiler nhận diện **chuỗi lock/unlock liên tiếp trên cùng object** → gộp thành 1 lock lớn:

```java
// Source:
synchronized (obj) { doA(); }
synchronized (obj) { doB(); }
synchronized (obj) { doC(); }

// JIT coarsened:
synchronized (obj) { doA(); doB(); doC(); }  // 1 lock thay vì 3
```

**Kể cả trong loop** (aggressive coarsening):

```java
for (int i = 0; i < 100; i++) {
    synchronized (obj) { list.add(i); }
}
// JIT có thể coarsen thành:
synchronized (obj) {
    for (int i = 0; i < 100; i++) { list.add(i); }
}
```

> [!NOTE]
> Coarsening **tăng** thời gian giữ lock → tăng contention nếu có thread khác chờ. JIT chỉ coarsen khi xác định contention thấp (profile-guided). Flag: `-XX:+EliminateLocks` (default ON).

---

## 10. Lock Elimination — JIT xoá lock không cần thiết

JIT + **Escape Analysis** phát hiện object **không escape** scope hiện tại → lock trên nó vô nghĩa (không thread nào khác thấy):

```java
public String concat(String a, String b) {
    StringBuffer sb = new StringBuffer();  // sb KHÔNG escape method
    sb.append(a);    // synchronized bên trong StringBuffer
    sb.append(b);    // synchronized bên trong StringBuffer
    return sb.toString();
}
// JIT: sb chỉ dùng local → không ai khác truy cập → XOÁ lock hoàn toàn
// → Chạy như StringBuilder (không sync)
```

**Điều kiện**: object phải **không escape** — không gán vào field, không return, không truyền cho thread khác.

```java
// ❌ Lock elimination KHÔNG xảy ra — object escape
private StringBuffer shared;
public void append(String s) {
    shared.append(s);  // shared escape → lock giữ nguyên
}
```

> [!TIP]
> Flag: `-XX:+DoEscapeAnalysis` (default ON) + `-XX:+EliminateLocks` (default ON). Để verify: `-XX:+PrintEliminatedLocks` (debug build). Đây là lý do `StringBuffer` gần bằng `StringBuilder` khi dùng local — JIT xoá lock rồi.

---

## 11. Adaptive Spinning — spin trước khi park

Trước khi park thread (fat lock → context switch đắt), JVM **spin** — vòng lặp busy-wait kiểm tra lock release:

```
CAS fail → spin loop:
  for (int i = 0; i < spinCount; i++) {
      if (CAS(_owner, NULL, current)) → lock acquired! (avoid park)
      pause;  // x86 PAUSE instruction (reduce power, hint pipeline)
  }
  → spin fail → park thread (OS context switch)
```

**Adaptive**: JVM theo dõi **history** — nếu spin thường thành công → tăng `spinCount`. Nếu spin thường fail → giảm `spinCount` (hoặc bỏ spin luôn):

```d2 title="Adaptive spinning tùy lịch sử monitor"
direction: right
r0n0: "Object A: spin thành công 80%"
r0n1: "spinCount tăng lên 200"
r0n0 -> r0n1
r1n0: "Object B: spin fail 95%"
r1n1: "spinCount giảm về 0"
r1n2: "park ngay, không đốt CPU"
r1n0 -> r1n1
r1n1 -> r1n2
```

> [!NOTE]
> Spin có lợi khi **critical section ngắn** (lock holder sắp release). Nếu critical section dài (I/O, computation), spin = đốt CPU vô ích. JVM adaptive strategy tự điều chỉnh — không cần tune thủ công.

---

## 12. synchronized vs ReentrantLock — khi nào dùng gì

| Tiêu chí | `synchronized` | `ReentrantLock` |
|----------|---------------|-----------------|
| Syntax | Block/method — tự release | Explicit `lock()`/`unlock()` trong try-finally |
| Fair option | Không (luôn unfair) | `new ReentrantLock(true)` |
| tryLock (timeout) | Không | `tryLock(5, SECONDS)` |
| lockInterruptibly | Không | ✅ |
| Multiple conditions | 1 (`wait/notify`) | Nhiều `Condition` objects |
| Performance (no contention) | Gần như bằng nhau (JIT optimize) | Gần bằng |
| Performance (contention) | Gần bằng (adaptive spin + inflate) | Gần bằng |
| Deadlock detection | Không | Không (nhưng tryLock giúp tránh) |
| Auto-release on exception | ✅ | ❌ Phải try-finally |

**Dùng `synchronized` khi:**
- Lock đơn giản, scope rõ ràng (block/method)
- Không cần timeout, interrupt, fair, multiple conditions
- Muốn code ngắn gọn, ít bug (tự release)

**Dùng `ReentrantLock` khi:**
- Cần tryLock / timeout → tránh deadlock
- Cần lockInterruptibly → cancel được
- Cần fair lock → đảm bảo latency bounded
- Cần nhiều Condition → phức tạp hơn wait/notify

> [!TIP]
> Default choice: **`synchronized`**. Chỉ chuyển sang `ReentrantLock` khi cần feature mà synchronized không có. Code đơn giản hơn = ít bug hơn.

---

## 13. Tóm tắt — Cheat sheet & 5 nguyên tắc

**Cỗ máy trong 6 dòng:**

```
1. Lock state nằm trong Object Header Mark Word (2 bit tag: 01/00/10)
2. Biased lock: ghi threadID, lần sau chỉ compare — gần zero cost (deprecated JDK 15+)
3. Thin lock: CAS mark word ↔ Lock Record trên stack — ~10-20 ns
4. Fat lock: ObjectMonitor (C++), _owner/_EntryList/_WaitSet, OS mutex — ~10-30 µs
5. JIT: lock elimination (escape analysis) + lock coarsening (merge adjacent locks)
6. Adaptive spinning: spin trước khi park, adjust spin count theo history
```

| Lock type | Cost | When |
|-----------|------|------|
| Biased | ~1 ns (1 compare) | Single-thread repeated lock |
| Thin (no contention) | ~10-20 ns (CAS) | Multi-thread, alternating |
| Fat (contention) | ~10-30 µs (park/unpark) | Multi-thread, simultaneous |
| Eliminated | 0 ns | Object doesn't escape (JIT) |

**5 nguyên tắc khắc cốt:**

1. **Lock contention là vấn đề, không phải synchronized** — single-thread lock gần zero cost. Giảm contention (shorten critical section, reduce lock scope) hiệu quả hơn đổi lock implementation.
2. **Lock escalation chỉ đi lên** — biased → thin → fat trong 1 acquisition cycle. JVM cố giữ ở level thấp nhất có thể.
3. **JIT aggressive optimize** — escape analysis xoá lock, coarsening gộp lock, adaptive spin tránh park. Đừng tự optimize bằng tay cái JIT đã lo.
4. **Keep critical section SHORT** — spin chỉ lợi khi holder sắp release. I/O trong synchronized = mọi thread park = throughput sập.
5. **Synchronized tự release khi exception** — advantage lớn so với ReentrantLock. Ít code = ít bug. Default choice trừ khi cần advanced features.

> [!TIP]
> Một câu để nhớ: *Synchronized rẻ khi không contention (JVM tối ưu tới tận hardware level), đắt khi contention (OS context switch). Mục tiêu không phải "tránh synchronized" mà là "giảm contention time".*
