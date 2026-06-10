---
title: "Memory Leak trong Java"
description: "Memory leak xảy ra ngay cả khi có GC: các nguyên nhân phổ biến, cách phát hiện bằng heap dump và phòng tránh."
---

> [!NOTE]
> Đây là bản nháp (placeholder). Nội dung chi tiết sẽ được bổ sung sau — phần dưới là dàn ý các đề mục dự kiến.

## Tổng quan

Memory leak xảy ra ngay cả khi có GC: các nguyên nhân phổ biến, cách phát hiện bằng heap dump và phòng tránh.

## Nội dung sẽ bao gồm

- GC vẫn leak — vì sao
- Nguyên nhân: static collection, listener, ThreadLocal, ClassLoader
- Phát hiện: heap dump, MAT, jmap/jvisualvm
- OutOfMemoryError các loại
- Best practices phòng tránh
