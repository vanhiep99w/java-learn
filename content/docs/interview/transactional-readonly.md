---
title: "Vì sao @Transactional(readOnly=true) vẫn ghi được DB?"
description: "Câu hỏi phỏng vấn Spring/JPA: gắn readOnly=true để 'chỉ đọc' nhưng vẫn UPDATE thành công, hoặc vẫn bị dirty checking flush xuống DB. Mổ xẻ readOnly thực sự làm gì (hint, không phải hàng rào), Hibernate FlushMode.MANUAL, tối ưu hiệu năng, và khi nào nó âm thầm không có tác dụng."
---

## Mục lục

- [1. Câu hỏi phỏng vấn](#1-câu-hỏi-phỏng-vấn)
- [2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)](#2-câu-trả-lời-30-giây-nếu-phỏng-vấn-hỏi-nhanh)
- [3. Hiểu lầm phổ biến: readOnly là "hàng rào chặn ghi"](#3-hiểu-lầm-phổ-biến-readonly-là-hàng-rào-chặn-ghi)
- [4. readOnly=true THỰC SỰ làm gì?](#4-readonlytrue-thực-sự-làm-gì)
- [5. Vì sao vẫn UPDATE được dù readOnly=true](#5-vì-sao-vẫn-update-được-dù-readonlytrue)
- [6. Lợi ích thật của readOnly — vì sao vẫn nên dùng](#6-lợi-ích-thật-của-readonly--vì-sao-vẫn-nên-dùng)
- [7. Khi readOnly âm thầm KHÔNG có tác dụng](#7-khi-readonly-âm-thầm-không-có-tác-dụng)
- [8. Cách thật sự chặn ghi nếu cần](#8-cách-thật-sự-chặn-ghi-nếu-cần)
- [9. Checklist chẩn đoán](#9-checklist-chẩn-đoán)
- [10. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp](#10-câu-hỏi-đào-sâu-mà-người-phỏng-vấn-sẽ-hỏi-tiếp)
- [11. Tóm tắt — Cheat sheet & 3 nguyên tắc](#11-tóm-tắt--cheat-sheet--3-nguyên-tắc)

---

## 1. Câu hỏi phỏng vấn

> *"Tôi gắn `@Transactional(readOnly = true)` lên một service method để đảm bảo nó **chỉ đọc**, không thể sửa DB. Nhưng trong method đó tôi vẫn `entity.setName(...)` rồi `repo.save(...)` — và dữ liệu **vẫn được ghi xuống DB thành công**. `readOnly=true` không chặn gì cả à? Vậy nó để làm gì? Và làm sao để thật sự chặn ghi?"*

Đây là câu hỏi tách "người gắn annotation theo thói quen" khỏi "người hiểu transaction + Hibernate". Người mới tưởng `readOnly=true` là **một cái khóa cứng** chặn mọi lệnh ghi. Người hiểu sâu biết: **`readOnly=true` chủ yếu là một *hint* (gợi ý tối ưu) cho persistence provider và driver, KHÔNG phải hàng rào an ninh chặn ghi ở tầng DB.**

> [!IMPORTANT]
> Mấu chốt: `@Transactional(readOnly=true)` **không** ra lệnh cho database "cấm ghi". Nó (1) set `FlushMode = MANUAL` trong Hibernate để **tắt dirty checking auto-flush**, và (2) truyền hint `Connection.setReadOnly(true)` xuống JDBC driver (driver/DB **có thể bỏ qua**). Việc ghi vẫn xảy ra nếu bạn gọi `save()`/`flush()` tường minh, hoặc nếu provider/DB không tôn trọng hint.

---

## 2. Câu trả lời 30 giây (nếu phỏng vấn hỏi nhanh)

> `readOnly=true` **không phải khóa chặn ghi**. Nó là gợi ý tối ưu:
> - Với **Hibernate/JPA**: đặt `FlushMode.MANUAL` → tắt **automatic dirty checking flush**. Nghĩa là sửa entity rồi mà không gọi flush/save tường minh thì thay đổi **không** tự động ghi xuống DB lúc commit → tiết kiệm chi phí so sánh snapshot, không cần giữ snapshot để so. Đây là lợi ích hiệu năng chính.
> - Với **JDBC**: gọi `connection.setReadOnly(true)` — chỉ là **hint**, driver/DB có thể tối ưu (vd định tuyến tới read replica) hoặc **lờ đi hoàn toàn**.
>
> Vì vậy nếu bạn **gọi `repo.save()` hay `flush()` tường minh**, hoặc DB không tôn trọng hint, lệnh ghi **vẫn chạy**. Muốn thật sự chặn ghi: dùng **DB user chỉ có quyền đọc**, **read replica**, hoặc kiểm soát ở tầng quyền — không dựa vào `readOnly=true`.

---

## 3. Hiểu lầm phổ biến: readOnly là "hàng rào chặn ghi"

```java
@Transactional(readOnly = true)
public void updateName(Long id, String name) {
    Product p = repo.findById(id).orElseThrow();
    p.setName(name);
    repo.save(p);          // 😱 vẫn ghi xuống DB thành công!
}
```

Nhiều người tin đoạn này sẽ ném exception hoặc bị chặn. Thực tế: **chạy bình thường, DB được cập nhật**. Vì `repo.save()` gọi flush tường minh, vượt qua cơ chế `FlushMode.MANUAL`.

> [!WARNING]
> `readOnly=true` **không** đảm bảo an toàn ghi. Đừng bao giờ dùng nó như cơ chế bảo mật/uỷ quyền ("method này chắc chắn không sửa được DB"). Nó là **gợi ý tối ưu hiệu năng**, không phải hàng rào. Tin nhầm điều này có thể dẫn tới lỗ hổng dữ liệu.

---

## 4. readOnly=true THỰC SỰ làm gì?

Khi Spring mở transaction với `readOnly=true`, nó tác động ở 2 tầng:

```text
@Transactional(readOnly=true)
        │
        ├──► Tầng Hibernate (JPA):
        │      session.setDefaultReadOnly(true)
        │      FlushMode = MANUAL
        │      → TẮT automatic dirty checking flush
        │      → entity load lên KHÔNG bị so sánh/auto-ghi lúc commit
        │      → không giữ snapshot để so → nhẹ bộ nhớ + nhanh hơn
        │
        └──► Tầng JDBC:
               Connection.setReadOnly(true)   ← chỉ là HINT
               → driver/DB CÓ THỂ:
                   • định tuyến tới read replica
                   • tối ưu (bỏ undo log, khóa nhẹ hơn)
                   • HOẶC lờ đi hoàn toàn (nhiều DB không cấm ghi)
```

### Dirty checking là gì (và vì sao tắt nó tiết kiệm)?

Bình thường Hibernate giữ một **snapshot** của mỗi entity load lên. Lúc commit, nó so entity hiện tại với snapshot để phát hiện thay đổi → tự sinh `UPDATE`. Với `readOnly=true`:
- Không giữ snapshot → **đỡ tốn RAM** (quan trọng khi load nhiều entity).
- Không quét dirty checking lúc flush → **nhanh hơn**.

> [!NOTE]
> Đây là lý do **vẫn nên gắn `readOnly=true` cho mọi method chỉ đọc** dù nó không chặn ghi: lợi ích hiệu năng (bỏ dirty checking, bỏ snapshot) là thật và đáng kể với truy vấn trả nhiều entity.

---

## 5. Vì sao vẫn UPDATE được dù readOnly=true

Có 2 đường khiến lệnh ghi vẫn chạy:

**(1) Bạn flush tường minh.** `FlushMode.MANUAL` chỉ tắt *auto*-flush. Khi gọi `repo.save()`, `entityManager.flush()`, hoặc native/JPQL `UPDATE`/`DELETE` query, lệnh ghi được gửi thẳng xuống DB — bỏ qua cơ chế read-only của Hibernate.

```java
@Transactional(readOnly = true)
public void f() {
    em.createQuery("update Product p set p.price = 0").executeUpdate();  // ✅ vẫn ghi!
}
```

**(2) DB không tôn trọng `setReadOnly`.** `Connection.setReadOnly(true)` chỉ là gợi ý. Nhiều DB (vd MySQL với một số cấu hình) **không thực sự cấm ghi** trên connection read-only — chúng chỉ coi đó là gợi ý tối ưu/định tuyến. PostgreSQL thì nghiêm hơn (có thể báo lỗi `cannot execute UPDATE in a read-only transaction` nếu transaction được set read-only ở tầng DB), nhưng hành vi **phụ thuộc DB + driver + cấu hình**.

```text
repo.save() ──► Hibernate flush tường minh ──► UPDATE gửi xuống DB
                                                   │
                                  DB có cấm không? ─┤
                                                   ├─ PostgreSQL (tx read-only thật): có thể lỗi
                                                   └─ MySQL (mặc định): thường vẫn ghi OK
```

> [!TIP]
> Hành vi "vẫn ghi được" **phụ thuộc database**. PostgreSQL có xu hướng chặn (ném lỗi) khi transaction thực sự read-only; MySQL thường cho qua. Vì không nhất quán, **đừng dựa vào readOnly để chặn ghi** — coi nó thuần tuý là tối ưu.

---

## 6. Lợi ích thật của readOnly — vì sao vẫn nên dùng

Dù không chặn ghi, `readOnly=true` mang lại giá trị thật:

| Lợi ích | Giải thích |
|---------|-----------|
| **Tắt dirty checking** | Không so snapshot lúc flush → nhanh hơn với truy vấn nhiều entity |
| **Tiết kiệm RAM** | Không giữ snapshot của entity → nhẹ heap |
| **Định tuyến read replica** | Driver/`AbstractRoutingDataSource` có thể route read-only tx sang replica → giảm tải master |
| **Tối ưu khóa/undo ở DB** | Một số DB dùng hint để giảm overhead khóa, không ghi undo log |
| **Biểu đạt ý định (intent)** | Đọc code thấy ngay "method này chỉ đọc" → dễ bảo trì, review |

> [!IMPORTANT]
> Quy tắc thực hành: **gắn `@Transactional(readOnly = true)` cho TẤT CẢ service method chỉ đọc**, và `@Transactional` (mặc định, read-write) cho method có ghi. Đây là best practice hiệu năng phổ biến, đặc biệt khi dùng kiến trúc master–replica.

---

## 7. Khi readOnly âm thầm KHÔNG có tác dụng

`readOnly=true` còn dễ "vô hiệu" theo các cách proxy quen thuộc — vì nó cũng là `@Transactional`, cùng cơ chế AOP proxy:

1. **Self-invocation** — gọi `this.method()` nội bộ → bỏ qua proxy → **không** transaction nào được mở, `readOnly` lẫn rollback đều không có. (Xem bài "@Transactional self-invocation".)
2. **Đã có transaction read-write bao ngoài** — với `Propagation.REQUIRED` (mặc định), method `readOnly=true` gọi *bên trong* một tx read-write đang mở sẽ **tham gia tx hiện có**, `readOnly` của nó **bị bỏ qua** (tx đã read-write rồi).
3. **Method không public / final** — CGLIB không proxy được → annotation bị bỏ qua.
4. **Gọi từ cùng class / không qua bean proxy** — như self-invocation.

```text
Tx read-write A (mở từ ngoài)
   └── gọi method B @Transactional(readOnly=true) [REQUIRED]
          → B tham gia tx A (không tạo tx mới)
          → readOnly=true của B BỊ BỎ QUA, tx vẫn read-write
```

> [!WARNING]
> `readOnly=true` chỉ có hiệu lực khi method **mở một transaction mới**. Nếu nó tham gia một tx read-write có sẵn (do `REQUIRED`), cờ read-only bị lờ đi. Muốn ép tx mới: `Propagation.REQUIRES_NEW` (nhưng cân nhắc kỹ vì tạo connection/tx mới).

---

## 8. Cách thật sự chặn ghi nếu cần

Nếu yêu cầu là **đảm bảo không thể ghi** (vd service báo cáo, read model), đừng dựa `readOnly=true`. Dùng:

| Cách | Mức đảm bảo | Ghi chú |
|------|:-----------:|--------|
| **DB user chỉ có quyền SELECT** | ✅ Cao nhất | DB từ chối mọi `INSERT/UPDATE/DELETE` — hàng rào thật |
| **Read replica (chỉ đọc)** | ✅ Cao | Kết nối tới replica không cho ghi |
| **Tách DataSource read-only** | ✅ | `AbstractRoutingDataSource` route sang datasource có user read-only |
| **PostgreSQL read-only tx** | ⚠️ Khá | DB ném lỗi khi ghi, nhưng phụ thuộc cấu hình |
| `@Transactional(readOnly=true)` | ❌ Thấp | Chỉ là hint tối ưu, KHÔNG chặn ghi |

```java
// Hàng rào thật: DB user chỉ SELECT
// GRANT SELECT ON ALL TABLES IN SCHEMA public TO report_readonly;
// REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM report_readonly;
```

> [!TIP]
> Nguyên tắc bảo mật: **kiểm soát quyền ghi ở tầng database/permission**, không ở annotation ứng dụng. Annotation có thể bị bỏ qua, bị bypass bằng native query, hoặc bị vô hiệu bởi self-invocation. Quyền DB thì không.

---

## 9. Checklist chẩn đoán

```text
╭──────────────────────────────────────────────────────────────╮
│ "readOnly=true mà vẫn ghi được" — vì sao?                     │
│                                                              │
│ B1. Có gọi save()/flush()/executeUpdate() tường minh không?  │
│     → Có → đó là lý do; readOnly chỉ tắt AUTO-flush          │
│                                                              │
│ B2. Method có đang tham gia tx read-write bao ngoài không?   │
│     → Có (REQUIRED) → readOnly bị bỏ qua                     │
│                                                              │
│ B3. Có self-invocation / method non-public/final không?      │
│     → Có → @Transactional bị bỏ qua hoàn toàn               │
│                                                              │
│ B4. DB có thực sự tôn trọng setReadOnly không?               │
│     → MySQL thường KHÔNG cấm; PostgreSQL có thể cấm          │
│                                                              │
│ KẾT LUẬN: cần chặn ghi thật → dùng DB user read-only/replica │
╰──────────────────────────────────────────────────────────────╯
```

---

## 10. Câu hỏi đào sâu mà người phỏng vấn sẽ hỏi tiếp

> **"`readOnly=true` tối ưu hiệu năng bằng cách nào cụ thể?"**
Đặt `FlushMode.MANUAL` → Hibernate không auto-flush, không giữ snapshot entity, không quét dirty checking lúc commit. Tiết kiệm CPU (không so sánh) và RAM (không snapshot), rõ rệt khi load nhiều entity.

> **"Nếu method readOnly mà vẫn cần ghi 1 entity thì sao?"**
Đó là dấu hiệu thiết kế sai — tách phần ghi sang method `@Transactional` read-write riêng. Đừng trộn đọc-ghi trong method khai báo readOnly.

> **"`readOnly=true` có ảnh hưởng isolation level / khóa không?"**
Không đổi isolation level. Nhưng một số DB dùng hint để giảm khóa / bỏ undo log → ít tranh chấp hơn. Hành vi tùy DB.

> **"Tại sao tham gia tx read-write bao ngoài thì readOnly bị bỏ qua?"**
`Propagation.REQUIRED`: nếu đã có tx, method tham gia tx đó thay vì tạo mới. Thuộc tính tx (gồm readOnly) được quyết bởi tx **ngoài cùng** mở ra nó. Cờ readOnly của method con bị lờ.

> **"Làm sao route read-only tx sang replica?"**
Dùng `AbstractRoutingDataSource` + `TransactionSynchronizationManager.isCurrentTransactionReadOnly()` để chọn datasource replica khi tx là read-only. Đây là ứng dụng thực tế quan trọng của cờ readOnly.

---

## 11. Tóm tắt — Cheat sheet & 3 nguyên tắc

**Cheat sheet:**

| Câu hỏi | Trả lời ngắn |
|---------|--------------|
| readOnly có chặn ghi? | ❌ Không — chỉ là hint tối ưu |
| Nó thực sự làm gì? | `FlushMode.MANUAL` (tắt auto dirty-flush) + `Connection.setReadOnly` hint |
| Vì sao vẫn ghi được? | save()/flush() tường minh; DB lờ hint; tham gia tx read-write |
| Có nên dùng không? | ✅ Có — cho mọi method chỉ đọc (lợi hiệu năng + route replica) |
| Chặn ghi thật thế nào? | DB user read-only / read replica / quyền DB |
| Khi nào bị vô hiệu? | self-invocation, non-public/final, tham gia tx read-write |

**Ba nguyên tắc:**

1. **`readOnly=true` là HINT tối ưu, KHÔNG phải hàng rào chặn ghi.** Nó tắt dirty checking + gợi ý driver, nhưng `save()`/`flush()` tường minh vẫn ghi được.
2. **Vẫn nên gắn cho mọi method chỉ đọc.** Lợi ích thật: bỏ dirty checking, nhẹ RAM, route read replica, biểu đạt ý định.
3. **Cần chặn ghi thật → kiểm soát ở tầng DB.** DB user read-only / replica / permission — không bao giờ dựa vào annotation ứng dụng.

> [!IMPORTANT]
> Câu trả lời ghi điểm trọn vẹn: **(1)** `readOnly=true` là **hint**, không phải khóa; **(2)** nó đặt **`FlushMode.MANUAL`** + gọi **`Connection.setReadOnly`**; **(3)** vẫn ghi được vì flush tường minh / DB lờ hint / tham gia tx read-write; **(4)** vẫn nên dùng cho hiệu năng; **(5)** muốn chặn ghi thật thì dùng **quyền DB / read replica**.
