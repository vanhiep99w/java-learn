---
title: "Concurrent Collections"
description: "Các collection thread-safe: ConcurrentHashMap, CopyOnWriteArrayList, BlockingQueue và so với Collections.synchronized*."
---

> [!NOTE]
> Đây là bản nháp (placeholder). Nội dung chi tiết sẽ được bổ sung sau — phần dưới là dàn ý các đề mục dự kiến.

## Tổng quan

Các collection thread-safe: ConcurrentHashMap, CopyOnWriteArrayList, BlockingQueue và so với Collections.synchronized*.

## Nội dung sẽ bao gồm

- Vấn đề với HashMap đa luồng
- ConcurrentHashMap — segment/bucket lock
- CopyOnWriteArrayList
- BlockingQueue & producer-consumer
- synchronizedMap vs ConcurrentHashMap
