---
title: "Heap vs Stack Memory"
description: "Phân biệt vùng nhớ Heap và Stack trong JVM: object, biến local, thread, vòng đời và GC."
---

> [!NOTE]
> Đây là bản nháp (placeholder). Nội dung chi tiết sẽ được bổ sung sau — phần dưới là dàn ý các đề mục dự kiến.

## Tổng quan

Phân biệt vùng nhớ Heap và Stack trong JVM: object, biến local, thread, vòng đời và GC.

## Nội dung sẽ bao gồm

- Stack — frame, biến local, mỗi thread một stack
- Heap — object, chia sẻ giữa thread, GC quản lý
- StackOverflowError vs OutOfMemoryError
- Reference vs value
- Sơ đồ minh hoạ bộ nhớ
