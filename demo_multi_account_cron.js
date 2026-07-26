export default {
    async fetch() {
        return new Response("Cron Worker is running.", { status: 200 });
    },
    async scheduled(event, env) {
        // ================= Thông tin tài khoản domain =================
        // KHÔNG hardcode token/ID vào source code — cấu hình qua Worker
        // secrets/variables (Dashboard > Worker > Settings > Variables,
        // hoặc `wrangler secret put CF_API_TOKEN`):
        //   CF_API_TOKEN  (secret)  — API token có quyền sửa DNS record
        //   CF_ZONE_ID    (var)     — Zone ID của domain
        //   CF_RECORD_ID  (var)     — ID của DNS record cần xoay
        const CF_API_TOKEN = env.CF_API_TOKEN;
        const CF_ZONE_ID = env.CF_ZONE_ID;
        const CF_RECORD_ID = env.CF_RECORD_ID;

        if (!CF_API_TOKEN || !CF_ZONE_ID || !CF_RECORD_ID) {
            console.log("Thiếu cấu hình: cần đặt CF_API_TOKEN, CF_ZONE_ID, CF_RECORD_ID trong Worker Variables/Secrets.");
            return;
        }

        const list = `
serverless-edge-dns-gateway-0ei.pages.dev
serverless-edge-dns-gateway-tui.pages.dev
serverless-edge-dns-gateway-zzz.pages.dev
......
serverless-edge-dns-gateway-09h.pages.dev
`.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('//') && !line.startsWith('#'))
            .map(line => line.split('#')[0].trim())
            .filter(line => line.length > 0);
        // ========================================================


        const api = `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${CF_RECORD_ID}`;
        const headers = { "Authorization": `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" };

        // 1. Kéo nội dung đang trỏ
        const resGet = await fetch(api, { headers });
        const { success, result, errors } = await resGet.json();

        // In LOG Nếu cấu hình nhập sai (Lỗi Token, sai Zone, ID)
        if (!success) {
            console.log(`Lỗi kết nối Cloudflare API:`, JSON.stringify(errors));
            return;
        }

        const nextTarget = list[(list.indexOf(result.content) + 1) % list.length];

        if (result.content === nextTarget) {
            console.log(`Đang là: ${result.content} | Bỏ qua không đổi.`);
            return;
        }

        // 2. Chuyển sang CNAME mới
        await fetch(api, { method: "PATCH", headers, body: JSON.stringify({ content: nextTarget }) });

        // In LOG Báo cáo thành công (Từ link cũ -> link mới)
        console.log(`Thành công! Vừa đổi từ [${result.content}] sang -> [${nextTarget}]`);
    }
};
