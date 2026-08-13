# 🛡️ Serverless Edge DNS Gateway
[English](README.md) | [Tiếng Việt](README_VN.md)

Dịch vụ DNS-over-HTTPS (DoH) bảo mật, hiệu năng cao, chạy trên hạ tầng Edge toàn cầu của Cloudflare Pages. Giải pháp tối ưu tốc độ truy cập, độ chính xác vị trí địa lý (ECS) và chặn quảng cáo chuyên nghiệp.

---

## ⚡ Tính năng nổi bật

*   **Mức độ sử dụng miễn phí**: chạy hoàn toàn trên gói Free của Cloudflare Pages với hạn mức 100,000 requests mỗi ngày. Với mức tiêu thụ trung bình 200 – 4000 requests/thiết bị/ngày, bạn có thể sử dụng khoảng 10-20 thiết bị trên cùng một tài khoản (thậm chí 100-200 thiết bị nếu dùng thông thường)
*   **Hỗ trợ Custom Domain**: Dễ dàng gắn tên miền riêng để có địa chỉ DNS ngắn gọn, chuyên nghiệp. Bạn có thể sử dụng nhiều tài khoản Cloudflare khác nhau để nhân bản hạn mức (x100k/tài khoản) mà vẫn dùng được tên miền tùy chỉnh.
*   **Chặn quảng cáo thông minh**: Tự động lọc quảng cáo tại Edge bằng các danh sách chuyên nghiệp (AdGuard, ABPVN, Bypass-VN...), được cập nhật tự động mỗi 3 giờ.
*   **Tối ưu hóa vị trí địa lý (ECS - RFC 7871)**: Tự động chèn EDNS Client Subnet (IPv4 `/24`, IPv6 `/48`) để đảm bảo các CDN (như Akamai, CloudFront, Fastly, BunnyCDN, Gcore) điều hướng bạn đến máy chủ gần nhất.
*   **Độ tin cậy cao với hệ thống dự phòng**: 
    *   **Primary/Fallback**: Tự động chuyển sang máy chủ dự phòng (*khác nhà cung cấp*) nếu máy chủ chính gặp sự cố.
    *   **Geo-Bypass**: Tự động phát hiện kết quả bị chặn địa lý (loopback 127.0.0.1) và phân giải lại qua **Mullvad DNS**.
*   **Token bảo vệ endpoint (tuỳ chọn)**: Đặt biến môi trường `DOH_TOKEN` để yêu cầu `/dns-query/<token>`, tránh người lạ dùng chùa làm cạn hạn mức miễn phí của bạn.
*   **Bộ lọc truy vấn sớm (Edge Filtering)**: Loại bỏ các truy vấn không cần thiết (`ANY`, `AAAA`, `PTR`, `HTTPS`) ngay tại Edge để tiết kiệm tài nguyên và tăng tốc độ phản hồi.
*   **Lớp bảo vệ TLD nội bộ**: Ngăn rò rỉ các domain nội bộ (như `.local`, `.lan`, trang quản trị router) ra môi trường internet bằng cách trả về `NXDOMAIN` ngay lập tức.
*   **Điều hướng DNS (CNAME Injection)**: Công cụ ép định tuyến domain A sang domain B bằng bản ghi CNAME. Giúp tùy chỉnh chính xác cụm máy chủ CDN mong muốn (Bilibili, TikTok, Medium...).
*   **Cài đặt không cần App**: Hỗ trợ tạo file `.mobileconfig` chính chủ cho Apple và tích hợp trang Landing Page trực quan.

---

## 🚀 Hướng dẫn triển khai

### 1. Fork dự án & Bật Actions
1. [Fork dự án này](../../fork) về tài khoản GitHub của bạn.
2. Truy cập tab **Actions** trong repository bạn vừa fork và nhấn **I understand my workflows, go ahead and enable them**.
3. Chọn và **Enable** thủ công 2 workflows: `Update DNS Blocklists` và `Delete Old Workflow Runs`. (`Update Filter Lists` là workflow Lớp 2 / CGPS tuỳ chọn — cứ để tắt nếu bạn chưa tạo các secrets mô tả ở [phần dưới](#-lớp-2-lọc-bảo-mật-bằng-cloudflare-gateway-cgps).)

### 2. Triển khai lên Cloudflare Pages
1. Vào [Workers & Pages > Create application > Connect to Git](https://dash.cloudflare.com/?to=/:account/pages/new/provider/github).
2. Chọn repository bạn vừa Fork.
3. **Build Settings**: Để **mặc định hoàn toàn** (không cần điền hay chỉnh sửa gì).
4. Nhấn **Save and Deploy**.

---

## ⚙️ Cấu hình

Các cài đặt theo từng deployment (upstream, token, CORS) được đọc từ **biến môi trường** — vào Cloudflare Pages > **Settings > Environment variables** để thiết lập, sau đó redeploy. Các công tắc tính năng (adblock, ECS, lọc loại truy vấn) vẫn nằm ở đầu file [functions/[[path]].js](functions/[[path]].js).

### Biến môi trường

| Biến | Mặc định | Mô tả |
| :--- | :--- | :--- |
| `UPSTREAM_PRIMARY` | `https://cloudflare-dns.com/dns-query` | URL máy chủ phân giải chính. |
| `UPSTREAM_FALLBACK` | `https://dns.google/dns-query` | Máy chủ dự phòng (nên dùng *nhà cung cấp khác* để failover có ý nghĩa thật sự). |
| `UPSTREAM_GEO_BYPASS`| `https://dns.mullvad.net/dns-query` | Dùng khi máy chủ chính trả về loopback (127.0.0.1). |
| `DOH_TOKEN` | *(trống)* | Token truy cập tuỳ chọn. Khi đặt, mọi endpoint yêu cầu token trong path: `/dns-query/<token>`, `/apple/<token>`, `/debug/<token>`. Path không có token trả về 404. |
| `CORS_ORIGIN` | *(trống)* | Origin CORS tuỳ chọn. DoH gốc của trình duyệt/hệ điều hành **không** cần CORS; chỉ đặt `*` nếu bạn muốn website bên ngoài truy vấn endpoint qua JavaScript. |
| `DEBUG_ENABLED` | *(trống)* | Đặt `true` để bật endpoint `/debug`. |

> [!IMPORTANT]
> Chỉ duy nhất **Cloudflare Gateway** mới đảm bảo trả về kết quả CDN chính xác nhất cho các dịch vụ như Akamai. Hãy tự tạo [DNS location](https://dash.cloudflare.com/?to=/:account/one/networks/resolvers-proxies) riêng trong tài khoản Cloudflare của bạn và đặt URL DoH của nó vào biến `UPSTREAM_PRIMARY`.

> [!WARNING]
> **Tuyệt đối không commit URL Gateway cá nhân vào repository.** Repo này công khai — ai fork về sẽ thừa hưởng upstream hardcode của bạn, khiến toàn bộ truy vấn DNS *của họ* đi qua tài khoản *của bạn* (đầy log Gateway và mọi lookup của họ bị gắn với tài khoản bạn). Nếu URL Gateway lỡ lọt vào git history, hãy xoay vòng: tạo DNS location mới, cập nhật biến môi trường `UPSTREAM_PRIMARY`, rồi xoá location cũ.

### Tối ưu hóa tại Edge
| Hằng số | Mặc định | Mô tả |
| :--- | :--- | :--- |
| `BLOCK_AAAA` | `false` | Chặn bản ghi IPv6 (buộc định tuyến qua IPv4). |
| `BLOCK_HTTPS` | `false` | Chặn truy vấn Type 65 (giúp tăng tốc độ phân giải). |
| `BLOCK_ANY` | `false` | Chặn các truy vấn ANY tiêu tốn tài nguyên. |
| `BLOCK_PTR` | `false` | Chặn truy vấn DNS ngược. |
| `BLOCK_PRIVATE_TLD` | `true` | Chặn các domain nội bộ hoặc router. |
| `ECS_INJECTION_ENABLED` | `true` | Bật ECS Injection (Cần thiết để trả về đúng CDN). |

---

## 🛠 Quản lý quy tắc (Rules)

Các quy tắc nằm trong thư mục `rules/`. Khi bạn thực hiện thay đổi và commit lên GitHub, Cloudflare Pages sẽ tự động đồng bộ và áp dụng cấu hình mới ngay lập tức.

Các quy tắc chi tiết:

*   **`blocklists.txt`**: Được GitHub Actions cập nhật tự động mỗi 3 giờ.
    *   **So khớp theo wildcard**: một entry chặn cả domain đó *lẫn mọi subdomain bên dưới*, bằng cách duyệt từ tên được truy vấn ngược lên gốc và dừng ở kết quả khớp đầu tiên. Đây đúng là ngữ nghĩa mà nguồn list phát hành — hagezi cố tình lược bỏ subdomain trong `wildcard/<list>-onlydomains.txt`, và chỉ ~1,5% list gộp là subdomain của một entry khác, nên cách so khớp exact trước đây để lọt phần lớn hostname quảng cáo thật (`doubleclick.net` bị chặn nhưng `googleads.g.doubleclick.net` vẫn phân giải bình thường).
    *   **Allowlist được ưu tiên theo từng cấp**, nên rule cụ thể hơn thắng: `foo.example.com` nằm trong allowlist vẫn vào được dù `example.com` bị chặn; ngược lại `ads.example.com` bị chặn vẫn chặn dù `example.com` nằm trong allowlist.
    *   **Cách cấu hình**: Thay đổi các URL trong lệnh `curl` bên trong file [update_lists.sh](update_lists.sh) để thêm hoặc bớt các nguồn chặn.
    *   **Chốt an toàn**: script huỷ cập nhật và giữ nguyên danh sách cũ nếu lỗi tải khiến danh sách tụt dưới 50.000 domain (đổi được bằng biến môi trường `MIN_DOMAINS`), hoặc nếu quá nửa số nguồn thất bại.
*   **`allowlists.txt`**: Do chính workflow sinh ra, từ hai nguồn: các list exclusion/exception của AdGuard, và toàn bộ rule ngoại lệ `@@` tìm thấy trong chính các nguồn blocklist. Domain ở đây được ưu tiên hơn `blocklists.txt` và bị trừ khỏi blocklist ngay lúc build, nên một domain không thể nằm ở cả hai list.
    *   **Vì sao `@@` quan trọng**: trong cú pháp AdBlock, `@@||example.com^` nghĩa là *đừng chặn* `example.com`. Nếu đưa thẳng rule đó vào blocklist thì đúng những domain mà tác giả filter cố ý mở chặn lại bị chặn — nên ngoại lệ được tách sang allowlist.
    *   **Chỉ dùng rule chặn cả domain**: rule cosmetic (`site.com##.ad-box`), rule có modifier (`||site.com^$popup`, `$third-party`, `$domain=`) và rule regex đều bị bỏ qua. Mỗi loại đều thu hẹp phạm vi theo ngữ cảnh mà DNS không nhìn thấy được; cắt bỏ phần thu hẹp đó sẽ biến "ẩn một banner trên trang này" thành "chặn cả trang này" — đó chính là cách một list dành cho trình duyệt có thể đánh sập một trang lớn.
    *   **Lưu ý**: file này bị ghi đè mỗi lần chạy — muốn thêm domain lâu dài thì thêm vào nguồn filter, hoặc thêm lại sau mỗi lần chạy.
*   **`private_tlds.txt`**: Thêm các domain nội bộ hoặc URL router của riêng bạn vào đây.
*   **`redirect_rules.txt`**: Điều hướng domain bằng cơ chế CNAME Injection (Domain A -> CNAME -> Domain B). Giúp tùy chỉnh CDN chính xác theo ý muốn.
    *   **Định dạng**: `domain-nguon domain-dich`
    *   **Ví dụ**: `www.bilibili.tv www.bilibili.tv.w.cdngslb.com`
    *   **Hiệu quả**: Nếu `www.bilibili.tv` trả về ngẫu nhiên nhiều CDN (như GSLB hoặc Akamai), quy tắc này sẽ ép nó luôn sử dụng `www.bilibili.tv.w.cdngslb.com`.

---

## 🧱 Lớp 2: Lọc bảo mật bằng Cloudflare Gateway (CGPS)

Project này kết hợp tự nhiên với [cloudflare-gateway-pihole-scripts (CGPS)](../../../cloudflare-gateway-pihole-scripts) theo kiến trúc **lọc 2 lớp**, vì upstream (`UPSTREAM_PRIMARY`) vốn đã là endpoint DoH của Cloudflare Gateway:

```
Thiết bị ──DoH──▶ Pages Function (Lớp 1: quảng cáo/tracking ~1M domain, ECS, redirect)
                        │
                        ▼
              Cloudflare Gateway (Lớp 2: list malware/phishing do CGPS quản lý
                        │          + security category có sẵn của Zero Trust)
                        ▼
                   Internet DNS
```

**Phân vai 2 lớp (tránh lãng phí quota 300k domain của Gateway):**

| Lớp | Nhiệm vụ | Danh sách |
| :--- | :--- | :--- |
| Edge (project này) | Quảng cáo, tracking, cờ bạc, telemetry | HaGeZi Pro++, AdGuard DNS,... (`update_lists.sh`) |
| Gateway (CGPS) | Malware, phishing, lừa đảo (TIF) | HaGeZi TIF Mini ([.github/workflows/Update_Gateway_Security_Lists.yml](.github/workflows/Update_Gateway_Security_Lists.yml)) |

> [!WARNING]
> **Đừng bật workflow này nếu bạn đã chạy CGPS ở nơi khác trên cùng tài khoản Cloudflare** — ví dụ một repo `cloudflare-gateway-pihole-scripts` riêng đang đẩy list quảng cáo lên Gateway. CGPS đặt tên list cố định (`CGPS List - Chunk N`) và dùng chung một rule (`CGPS Filter Lists`), nên hai bản CGPS trên cùng tài khoản sẽ ghi đè lẫn nhau: bên chạy sau chiếm các chunk đầu. Không có cơ chế namespace nào tách được hai bộ list. Mà quota 300.000 item của gói Free cũng không đủ: list quảng cáo ~298k cộng TIF ~170k là 468k, vượt trần.
>
> Trong trường hợp đó, hãy lấy malware/phishing từ **Security Categories** có sẵn: miễn phí, do Cloudflare tự cập nhật, và không tính vào quota 300k. Workflow này chỉ hợp lý khi Gateway của bạn dành riêng cho bảo mật, còn quảng cáo do lớp 1 lo hết tại edge.

**Lưu ý khi thiết lập:**

*   Workflow lớp 2 nằm **ngay trong repo này** (lúc chạy nó checkout code CGPS từ `mrrfv/cloudflare-gateway-pihole-scripts@v1`, nên không cần repo riêng). Workflow **chỉ chạy thủ công** (`workflow_dispatch`) — cố ý không có lịch tự động để nó không thể âm thầm ghi đè list của một bản CGPS khác. Muốn chạy cần 2 secrets: `CLOUDFLARE_API_TOKEN` (quyền đọc/sửa Zero Trust) và `CLOUDFLARE_ACCOUNT_ID`.
*   Dùng **đúng tài khoản Cloudflare** sở hữu endpoint Gateway đã khai trong `UPSTREAM_PRIMARY` / `UPSTREAM_FALLBACK`.
*   [rules/allowlists.txt](rules/allowlists.txt) là **allowlist dùng chung**: lớp Edge đọc trực tiếp, workflow lớp 2 kéo đúng file đó qua raw URL nên 2 lớp cùng mở chặn một tập domain. File này do workflow lớp 1 sinh lại mỗi lần chạy, nên muốn thêm domain lâu dài thì thêm vào nguồn allowlist của workflow đó chứ không sửa trực tiếp file. Lớp 2 nhận allowlist mới ở lần bạn chạy nó thủ công kế tiếp.
*   Workflow **fail rõ ràng nếu nguồn list hỏng**. Bộ tải của CGPS không kiểm tra HTTP status — URL 404 vẫn tạo file rỗng rồi báo thành công — nên có thêm bước kiểm tra: dừng job nếu blocklist dưới 50.000 domain (đổi được bằng Actions variable `MIN_BLOCK_DOMAINS`).
*   Nên bật thêm các **Security Category có sẵn** (malware, phishing, new domains) trong Gateway policy của Zero Trust — hoàn toàn miễn phí và không tính vào quota 300k.
*   Giữ nguyên kiểu chặn mặc định của Gateway (trả về `0.0.0.0`). **Không** dùng kiểu chặn trả về `127.0.0.1` — logic Geo-Bypass sẽ coi đó là geo-block và re-resolve qua Mullvad, vô tình mở chặn domain đó.

---

## 📱 Hướng dẫn cài đặt

### Trình duyệt (Chrome / Edge / Firefox)
1.  Vào **Cài đặt** > **Quyền riêng tư và bảo mật** > **Bảo mật**.
2.  Bật **"Sử dụng DNS bảo mật"** và chọn **"Tùy chỉnh"**.
3.  Dán URL của bạn: `https://your-project.pages.dev/dns-query`

### Apple (iOS / macOS)
1.  Mở URL dự án của bạn bằng trình duyệt **Safari**.
2.  Nhấn **Download Apple Profile** và cài đặt trong phần **Cài đặt hệ thống**.

### Android (App Intra)
1.  Mở ứng dụng Intra > **Cấu hình URL máy chủ tùy chỉnh**.
2.  Dán URL `/dns-query` của bạn và bật kết nối.

---

## 🔎 API & Các Endpoint

| Endpoint | Mô tả |
| :--- | :--- |
| `/dns-query` | Endpoint để thực hiện truy vấn DoH. |
| `/debug` | Trả về JSON tóm tắt cấu hình, thống kê và số lượng rule đang nạp (cần `DEBUG_ENABLED=true`). |
| `/apple` | Tạo file cấu hình `.mobileconfig` cho các thiết bị Apple. |

> [!NOTE]
> Khi đã đặt `DOH_TOKEN`, thêm token vào mọi endpoint: `/dns-query/<token>`, `/debug/<token>`, `/apple/<token>`. File cấu hình Apple sinh ra sẽ tự động nhúng URL kèm token.

---
