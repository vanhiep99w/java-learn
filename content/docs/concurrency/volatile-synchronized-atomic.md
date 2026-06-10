---
title: "volatile, synchronized & Atomic"
description: "Ba cơ chế đồng bộ hoá: volatile (visibility), synchronized (mutual exclusion) và Atomic/CAS (lock-free)."
---

> [!NOTE]
> Đây là bản nháp (placeholder). Nội dung chi tiết sẽ được bổ sung sau — phần dưới là dàn ý các đề mục dự kiến.

## Tổng quan

Ba cơ chế đồng bộ hoá: volatile (visibility), synchronized (mutual exclusion) và Atomic/CAS (lock-free).

## Nội dung sẽ bao gồm

- volatile — visibility, không atomic
- synchronized — monitor lock, HB edge
- Atomic* & CAS (compare-and-swap)
- VarHandle, StampedLock
- Khi nào dùng cái nào
