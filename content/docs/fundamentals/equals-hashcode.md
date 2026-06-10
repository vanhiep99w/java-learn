---
title: "equals() & hashCode()"
description: "Hợp đồng giữa equals() và hashCode(), tại sao phải override cùng nhau, ảnh hưởng tới HashMap/HashSet."
---

> [!NOTE]
> Đây là bản nháp (placeholder). Nội dung chi tiết sẽ được bổ sung sau — phần dưới là dàn ý các đề mục dự kiến.

## Tổng quan

Hợp đồng giữa equals() và hashCode(), tại sao phải override cùng nhau, ảnh hưởng tới HashMap/HashSet.

## Nội dung sẽ bao gồm

- Mặc định trong Object (so sánh reference)
- Contract: equals true ⇒ hashCode bằng nhau
- Cách override đúng & hiệu quả
- Hệ quả khi vi phạm contract trong HashMap/HashSet
- Dùng record / Objects.hash()
