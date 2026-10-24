# Java Learning

Tài liệu học Java tiếng Việt — Java Core, JVM, Collections, Concurrency, Design Patterns, Spring.

## Mục lục

- [Stack](#stack)
- [Development](#development)
- [Sơ đồ D2](#sơ-đồ-d2)
  - [Chọn layout engine](#chọn-layout-engine)
- [Learning fences và D2 tương tác](#learning-fences-và-d2-tương-tác)
- [Source Explorer](#source-explorer)
- [Kiểm tra](#kiểm-tra)
  - [Phạm vi xác minh migration](#phạm-vi-xác-minh-migration)
- [Deploy](#deploy)

## Stack

- Next.js 16 + Fumadocs + Cloudflare Pages (static export).
- `@vanhiep99w/docs-kit@0.12.0` pin chính xác từ npm: D2 render lúc build, learning fences và Source Explorer lazy-load.
- Node.js **22 trở lên**. Không cần D2 CLI, Go hoặc Java để build website.

## Development

```bash
npm ci
npm run dev
```

`predev` và `prebuild` tự sinh dữ liệu source từ các code fence có metadata. Khi thêm/sửa ví dụ trong lúc dev đang chạy, chạy lại `npm run sources:build` rồi reload trang/drawer.

## Sơ đồ D2

Ưu tiên D2 cho kiến trúc, flowchart, quan hệ object, state machine đơn giản và ERD. Ví dụ trong `content/docs/*.md` hoặc `.mdx`:

````md
```d2 title="Luồng xử lý request"
direction: right
client: Client
service: Service
db: Database { shape: cylinder }
client -> service: request
service -> db: query
```
````

- Dùng nhãn ngắn; xuống dòng bằng `\n`. Caption không chứa dấu backtick vì Markdown không cho phép backtick trong info string của fence này.
- Toàn bộ sơ đồ dùng D2: **506 fence, 508 view** (gồm 3 trạng thái `allOf`). Bốn Mermaid dài đã tách theo phase thành D2 sequence; các nhóm success/error là nhánh thay thế, không phải hai nhánh chạy liên tiếp. Giữ actor, nhãn và cleanup; `postHandle` chỉ chạy khi handler thành công. Đổi layout engine không thay thế việc kiểm tra ngữ nghĩa.
- Giữ text cho log, bytecode, công thức, payload, cây thư mục, phép toán bit và những ví dụ mà vị trí ký tự là nội dung cần học. Object/heap layout mang tính sơ đồ đã chuyển sang D2; byte payload và annotation định dạng (serialization, BCrypt) vẫn là text, không đổi thành graph.
- Không tự động đổi mọi text có mũi tên thành sơ đồ. Không suy quan hệ từ cột/ký tự kẻ cây: phải khai báo lại node và edge theo ngữ nghĩa.
- Với chuỗi dài, tách theo giai đoạn hoặc dùng grid hai cột có mũi tên nối các ô kề nhau. Không thu nhỏ font hay đặt `max-height` để che bớt hình.
- `npm run docs:inventory` đối chiếu **311 fence không phải sơ đồ** đã review trong `scripts/diagram-inventory.json` (SHA-256 + phân loại), đồng thời lưu dấu vết 155 fence đã chuyển. Fence text mới/sửa chưa review, Mermaid hoặc box/bar ngoài code làm kiểm tra fail; không tự động coi mọi mũi tên là graph. Khi sửa text hợp lệ, review lại rồi cập nhật đúng entry, không tắt guard.
- `npm run docs:audit` đo từng SVG light/dark, kể cả board tương tác, và liệt kê hình quá cao/hẹp hoặc quá rộng; báo cáo đầy đủ nằm ở `.cache/docs-kit/diagram-audit.json`. Cảnh báo là điểm cần review, không tự thay layout. Các sơ đồ đã sửa trong JVM/lifecycle có budget kích thước để bắt regression.

Plugin trong `source.config.ts` sinh SVG light/dark lúc build; trình duyệt không tải D2/WASM. Cache ở `.next/cache/docs-kit/d2`, không phải tài nguyên deploy. Có thể bật Build cache trong Cloudflare Pages và kiểm tra log restore cache của môi trường thực tế.

### Chọn layout engine

Dùng chung options trong `scripts/d2-options.mjs` cho website, kiểm tra và audit. **ELK vẫn là mặc định**, không đổi toàn site sang TALA.

| Engine | Chỗ đang dùng / tiêu chí chọn |
|---|---|
| **ELK** | Grid JVM/lifecycle đã gấp gọn, sequence, cây Throwable/Collections và flowchart hiện đọc tốt. Giữ layout ổn định; TALA không phải lúc nào cũng nhỏ hơn. |
| **Dagre** | Chuỗi ClassLoader trong JVM Architecture và hai ERD RBAC dạng phân tầng. Sau so sánh, các hình này bớt cao mà đường nối vẫn rõ. |
| **TALA** | Graph strong/weak reference, object layout có container, ERD nhiều nhánh, state machine có cạnh ngược (JPA, executor, connection, Saga). Deadlock ba thread dùng `top`/`left` để giữ các đỉnh và đường chờ dễ theo dõi. |

Đã so sánh 43 sơ đồ đại diện với cả ba engine. Một số kết quả ở scale/font giữ nguyên:

| Sơ đồ | ELK | Layout được chọn |
|---|---|---|
| Object header / fields / padding | 1173×219 | TALA: 486×443 |
| Lifecycle ThreadPoolExecutor | 1867×126 | TALA: 906×345 |
| Persistence context lifecycle | 1761×312 | TALA: 808×584 |
| ACL ERD có self-reference | 1325×896 | TALA: 670×548 |

Đây là số đo của source/version hiện tại, không phải cam kết mọi sơ đồ đều gọn hơn. Chọn theo khả năng đọc, điều kiện/đường nối và kích thước khung bài, không chỉ diện tích. TALA có thể đổi bố cục mạnh khi sửa nhãn; cần review lại sau khi thay source.

**Ưu tiên cấu hình:** `layout` của fence → `d2Layout` trong frontmatter → options chung → ELK.

````md
---
title: Connection Pool
d2Layout: tala
---

```d2 layout="elk" title="Architecture: giữ ELK cho riêng hình này"
client -> pool -> database
```

```d2 title="Lifecycle: kế thừa TALA của page"
idle -> in_use: borrow
in_use -> idle: return
```
````

`src/lib/docs-schema.mjs` giữ field `d2Layout` khi Fumadocs validate frontmatter. Giá trị sai hoặc fence khai báo layout lặp sẽ làm kiểm tra/build thất bại, không âm thầm fallback. Chỉ dùng constraint riêng như `top`/`left` khi engine được resolve là TALA.

Quyết định và lý do review nằm trong `scripts/d2-layout-review.json`. So sánh lại mà **không sửa docs**:

```bash
npm run docs:compare-layouts -- --selection scripts/d2-layout-review.json --limit 50
# Hoặc giới hạn một bài, tránh render TALA toàn site chỉ để thử:
npm run docs:compare-layouts -- --filter connection-pool --limit 2
```

Xem `.cache/docs-kit/layout-comparison/index.html` và `report.json`. Mỗi variant có SVG light/dark ở kích thước thật; lỗi engine cũng được ghi vào report. `elapsedMs` có thể bao gồm cache hit, không phải benchmark. Source có constraint chỉ dành cho TALA có thể không chạy với engine khác; không xóa constraint chỉ để ép phép so sánh.

Sau `docs:audit` và `build`, chạy `docs:check-export` để đối chiếu **toàn bộ SVG trong static HTML** với số đo audit. Việc này giúp phát hiện frontmatter bị host loại bỏ, cache/layout không khớp hoặc khác biệt giữa pipeline kiểm tra và Fumadocs thực tế.

## Learning fences và D2 tương tác

`source.config.ts` đăng ký 5 plugin qua `scripts/learning-plugins.mjs`; MDX map và CSS nằm ở `src/app/[[...slug]]/page.tsx`, `src/app/globals.css`. Các descriptor được validate nghiêm ngặt lúc compile; không tự viết props/tokens đã prepare.

- `terminal-session`, `code-diff`, `code-walkthrough`: bài Optional (pipeline và kiểm chứng eager/lazy).
- `protocol-exchange`: bài REST vs SOAP (200/404, JSON body là string).
- `span-waterfall`: bài CompletableFuture (timeline minh họa, provenance bắt buộc).
- D2 mặc định static; fence `interactive` hoặc `mode=steps` mới opt-in. CompletableFuture dùng steps để phân biệt từng future với barrier `allOf`. Viewer không chạy code hay compiler trong browser.
- `assetsRoot: content/assets/d2` nhúng icon local vào SVG lúc build; provenance/checksum ở `content/assets/d2/README.md`. Giữ `d2Layout` và thứ tự ưu tiên layout cũ.

## Source Explorer

Dùng drawer để đối chiếu nhiều ví dụ mà không cuộn tìm lại code. Source vẫn có trong bài; dữ liệu drawer được tạo từ **chính code fence**, không duy trì thêm bản copy dễ lệch nội dung.

Gắn metadata `source="project-id/path/to/File.java"` vào code cần reference:

````md
```java source="order-example/01/OrderService.java"
class OrderService {
    void place() {
        // Ví dụ minh họa.
    }
}
```

<SourceRef project="order-example" file="01/OrderService.java" region="example" variant="button">
  Xem OrderService.java cùng các ví dụ khác
</SourceRef>
````

Thêm fence khác với cùng `project-id` và path khác để có nhiều file trong drawer. Mỗi project thuộc một bài; title lấy từ frontmatter. Các thư mục đánh số trong docs hiện tại là **ví dụ độc lập**, không phải source của một ứng dụng có thể chạy nguyên khối.

Pipeline `scripts/build-source-examples.mjs`:

- Đọc `.md` và `.mdx`; tạo snapshot `main`, region `example` bao trùm toàn bộ mỗi fence. Ngôn ngữ hỗ trợ: Java, SQL, YAML, XML, properties, Bash, JSON và text.
- Sinh manifest/snapshot JSON trong `public/source-examples/`, highlight Shiki hai theme và đánh số `.line[data-line]` từ 1.
- Kiểm tra project, file, snapshot, region và `lines="1-4"`; không kết hợp `lines` với `region`. Reference sai hoặc file trùng làm build thất bại.
- Assets được sinh lại trước dev/build, không commit. Chỉ đưa ví dụ đáng tin cậy vào source: **mọi code/HTML trong assets đều công khai**, không chứa secrets.

`SourceRef` phải dùng string literal; nhãn là plain text. Remark adapter trong `scripts/source-references.mjs` hỗ trợ cú pháp này cả trong `.md` (không mặc định hiểu JSX) và `.mdx`. Provider client tại `src/components/source-explorer.tsx` reset drawer theo pathname; không reset khi đổi query chọn file.

## Kiểm tra

```bash
npm test                  # 46 tests: source, layouts, learning descriptors, inventory
npm run typecheck
npm run docs:inventory     # Không còn diagram legacy; text/code/log/payload được phân loại riêng
npm run docs:check         # Validate references, 5 learning fences, toàn bộ D2 light/dark
npm run docs:audit         # Đo từng view và cả hai theme; kiểm tra layout budgets
npm run build             # Sinh source assets + static export
npm run docs:check-export  # Đối chiếu tất cả SVG light/dark với audit; không có icon remote
npm run test:browser       # Chromium trên dist: light/dark, 1440/390px và no-JS
```

`docs:check` dùng cùng cache D2 với build. Lượt cache lạnh cần thêm thời gian để render SVG. Browser smoke cần Chromium của Playwright (`npx playwright install chromium` nếu máy chưa có); không deploy site để kiểm tra.

### Phạm vi xác minh migration

- Đã chuyển 151 sơ đồ text/Unicode và 4 Mermaid (tách 4 sequence dài thành 10 phase views). Kết quả: 506 fence D2, 508 static views kể cả fallback boards; 311 fence text/code/payload được review và giữ riêng trong inventory.
- Giữ nguyên 88 URL/frontmatter, toàn bộ `meta.json`, stack Next/React/Fumadocs và 183 code fence gốc của Source Explorer (31 projects). Icon Java được nhúng local, checksum đối chiếu trực tiếp catalog.
- Browser smoke có 60 lượt trên 12 bài đại diện: controls/copy của 5 learning components, D2 steps/fit/expand/Escape, Source Explorer và fallback không JavaScript. Screenshot/report ở `.cache/docs-kit/browser-smoke/` (không commit generated artifacts). Đã sửa wrap identifier/heading trên mobile, không giấu sơ đồ bằng giới hạn chiều cao.
- Hạn chế: browser smoke không phải visual audit mọi view hoặc chạy mọi ví dụ Java/JMH. 17 sơ đồ cũ vẫn được audit đánh dấu cao/hẹp hoặc rộng; dùng cuộn nội bộ, và các sequence mới nhiều actor có Explore/zoom/expand. 31/31 layout budgets vẫn qua. Chưa xác minh deployment Cloudflare thực tế; build không chứng nhận các số benchmark có sẵn trong bài.

## Deploy

```bash
npm run deploy
```

Cloudflare Pages dùng build command `npm run build`, output directory `dist`. Các JSON của Source Explorer tự được copy vào static export; không cần API/server riêng.
