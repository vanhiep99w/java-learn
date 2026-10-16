# Java Learning

Tài liệu học Java tiếng Việt — Java Core, JVM, Collections, Concurrency, Design Patterns, Spring.

## Mục lục

- [Stack](#stack)
- [Development](#development)
- [Sơ đồ D2](#sơ-đồ-d2)
- [Source Explorer](#source-explorer)
- [Kiểm tra](#kiểm-tra)
- [Deploy](#deploy)

## Stack

- Next.js 16 + Fumadocs + Cloudflare Pages (static export).
- `@vanhiep99w/docs-kit@0.3.x`: D2 render lúc build và Source Explorer lazy-load.
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
- Giữ Mermaid cho các sequence có `alt`/`else`, `loop`, `opt`, hoặc state diagram có chú thích mà việc chuyển đổi có thể làm mất ngữ nghĩa. Component Mermaid hiện có vẫn được đăng ký.
- Giữ text cho log, bytecode, công thức, payload, cây thư mục, bit layout và những ví dụ mà vị trí ký tự là nội dung cần học.
- Không tự động đổi mọi text có mũi tên thành sơ đồ.

Plugin trong `source.config.ts` sinh SVG light/dark lúc build; trình duyệt không tải D2/WASM. Cache ở `.next/cache/docs-kit/d2`, không phải tài nguyên deploy. Có thể bật Build cache trong Cloudflare Pages và kiểm tra log restore cache của môi trường thực tế.

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
npm test                 # Pipeline assets, validation, Markdown/MDX references
npm run typecheck
npm run docs:check       # Validate references và compile tất cả D2 light/dark
npm run build            # Sinh source assets + static export
```

`docs:check` dùng cùng cache D2 với build. Lượt cache lạnh cần thêm thời gian để render SVG.

## Deploy

```bash
npm run deploy
```

Cloudflare Pages dùng build command `npm run build`, output directory `dist`. Các JSON của Source Explorer tự được copy vào static export; không cần API/server riêng.
