// DNSHE 多账号自动续期脚本 for Loon（修复版）  
// 参数格式: tg_bot=<Token>;tg_chatid=<ID>;pushplus=<Token>;账户名:APIKey:APISecret;...  
const API_BASE = 'https://api005.dnshe.com/index.php?m=domain_hub&endpoint=subdomains';  
const RENEW_WINDOW_DAYS = 180;  
const REQUEST_DELAY = 1800; // 1.8秒，留出余量避免 60/min 限制  
const MAX_RETRIES = 2;  
  
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }  
  
// 通用 HTTP 请求（支持重试）  
async function httpRequest(method, url, headers, body = null, retries = MAX_RETRIES) {  
    for (let i = 0; i <= retries; i++) {  
        try {  
            const resp = await new Promise((resolve, reject) => {  
                const params = { url, headers, timeout: 15000 };  
                if (body) params.body = JSON.stringify(body);  
                $httpClient[method.toLowerCase()](params, (err, response, data) => {  
                    if (err) reject(err);  
                    else resolve({ status: response.status, body: JSON.parse(data) });  
                });  
            });  
            return resp;  
        } catch (e) {  
            if (i === retries) throw e;  
            await sleep(2000 * (i + 1)); // 递增重试延迟  
        }  
    }  
}  
  
// 获取单个子域名详情（用于补全 expires_at）  
async function getSubdomainDetail(apiKey, apiSecret, subdomainId) {  
    const url = `${API_BASE}&action=get&subdomain_id=${subdomainId}`;  
    const { status, body } = await httpRequest('GET', url, { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret });  
    if (status !== 200 || !body.success) throw new Error(`Get detail failed: ${JSON.stringify(body)}`);  
    return body.subdomain;  
}  
  
// 分页获取全部子域名（含 expires_at 兜底）  
async function fetchAllSubdomains(apiKey, apiSecret) {  
    let all = [];  
    let page = 1;  
    const perPage = 200; // 推荐200，兼顾速度和稳定性  
    const fields = 'id,full_domain,status,expires_at';  
    while (true) {  
        const url = `${API_BASE}&action=list&page=${page}&per_page=${perPage}&fields=${fields}`;  
        const { body } = await httpRequest('GET', url, { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret });  
        if (!body.success) throw new Error(`List page ${page} error: ${JSON.stringify(body)}`);  
        const items = body.subdomains || [];  
        // 如果某些项没有 expires_at，尝试单个获取（仅对 active 的做，减少请求）  
        for (let item of items) {  
            if (!item.expires_at && item.status === 'active') {  
                try {  
                    const detail = await getSubdomainDetail(apiKey, apiSecret, item.id);  
                    item.expires_at = detail.expires_at || null;  
                    await sleep(500); // 获取详情也小间隔  
                } catch (e) {  
                    // 获取失败则不续期，稍后会归为跳过  
                    console.log(`无法补全 ${item.full_domain} 过期时间: ${e.message}`);  
                }  
            }  
        }  
        all = all.concat(items);  
        if (body.pagination?.has_more) { page++; await sleep(1200); }  
        else break;  
    }  
    return all;  
}  
  
// 续期单个域名  
async function renewSubdomain(apiKey, apiSecret, subdomainId) {  
    const url = `${API_BASE}&action=renew`;  
    const { body } = await httpRequest('POST', url, {  
        'X-API-Key': apiKey,  
        'X-API-Secret': apiSecret,  
        'Content-Type': 'application/json'  
    }, { subdomain_id: subdomainId });  
    return body; // 直接返回响应体  
}  
  
// 判断续期窗口（到期前180天，包含过期30天内）  
function isInRenewWindow(expiresStr) {  
    if (!expiresStr) return false;  
    const d = new Date(expiresStr.replace(' ', 'T') + '+08:00');  
    if (isNaN(d.getTime())) return false;  
    const diffDays = (d.getTime() - Date.now()) / 86400000;  
    return diffDays <= RENEW_WINDOW_DAYS && diffDays >= -30;  
}  
  
// 发送 Telegram  
function sendTelegram(botToken, chatId, text) {  
    $httpClient.post({  
        url: `https://api.telegram.org/bot${botToken}/sendMessage`,  
        headers: { 'Content-Type': 'application/json' },  
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),  
        timeout: 10000  
    }, () => {});  
}  
  
// 发送 PushPlus  
function sendPushPlus(token, text, title) {  
    $httpClient.post({  
        url: 'http://www.pushplus.plus/send',  
        headers: { 'Content-Type': 'application/json' },  
        body: JSON.stringify({ token, title: title || 'DNSHE Renew Report', content: text, template: 'html' }),  
        timeout: 10000  
    }, () => {});  
}  
  
// 解析配置  
function parseConfig(arg) {  
    const accounts = [];  
    let tgBot = '', tgChatid = '', pushplusToken = '';  
    if (!arg) return { accounts, tgBot, tgChatid, pushplusToken };  
    arg.split(';').map(s => s.trim()).filter(Boolean).forEach(item => {  
        if (item.includes('=')) {  
            const [k, v] = item.split('=').map(s => s.trim());  
            if (k === 'tg_bot') tgBot = v;  
            else if (k === 'tg_chatid') tgChatid = v;  
            else if (k === 'pushplus') pushplusToken = v;  
        } else if (item.includes(':')) {  
            const parts = item.split(':');  
            if (parts.length >= 3) accounts.push({ name: parts[0].trim(), apiKey: parts[1].trim(), apiSecret: parts[2].trim() });  
            else if (parts.length === 2) accounts.push({ name: `账户${accounts.length+1}`, apiKey: parts[0].trim(), apiSecret: parts[1].trim() });  
        }  
    });  
    return { accounts, tgBot, tgChatid, pushplusToken };  
}  
  
// --------- 主流程 ---------  
async function main() {  
    const { accounts, tgBot, tgChatid, pushplusToken } = parseConfig(typeof $argument !== 'undefined' ? $argument : '');  
    if (!accounts.length) {  
        $notification.post('DNSHE Renew', '无有效账户', '请在脚本参数中配置账户');  
        return;  
    }  
    const report = [];  
    let totalSuccess = 0, totalSkipped = 0, totalFailed = 0;  
  
    for (const acc of accounts) {  
        let domains;  
        try {  
            domains = await fetchAllSubdomains(acc.apiKey, acc.apiSecret);  
        } catch (e) {  
            report.push({ account: acc.name, error: `获取域名列表失败: ${e.message || e}` });  
            continue;  
        }  
        const success = [], skipped = [], failed = [];  
        for (const d of domains) {  
            const name = d.full_domain || `ID:${d.id}`;  
            if (d.status !== 'active') {  
                skipped.push(`${name} (状态:${d.status})`);  
                continue;  
            }  
            if (!isInRenewWindow(d.expires_at)) {  
                skipped.push(`${name} (${d.expires_at ? '到期:'+d.expires_at : '无过期数据'})`);  
                continue;  
            }  
            // 实际续期  
            try {  
                const res = await renewSubdomain(acc.apiKey, acc.apiSecret, d.id);  
                if (res.success) {  
                    const newExp = res.new_expires_at || '已续期';  
                    success.push(`${name} → ${newExp}`);  
                } else {  
                    failed.push(`${name}: ${res.message || JSON.stringify(res)}`);  
                }  
            } catch (e) {  
                failed.push(`${name}: ${e.message || e}`);  
            }  
            await sleep(REQUEST_DELAY);  
        }  
        totalSuccess += success.length;  
        totalSkipped += skipped.length;  
        totalFailed += failed.length;  
        report.push({ account: acc.name, success, skipped, failed });  
    }  
  
    // 构建纯文本详细报告（通知用）  
    let reportText = `DNSHE 续期报告\n总计 — 成功:${totalSuccess} 跳过:${totalSkipped} 失败:${totalFailed}\n\n`;  
    report.forEach(r => {  
        reportText += `=== ${r.account} ===\n`;  
        if (r.error) { reportText += `❌ ${r.error}\n\n`; return; }  
        reportText += `✅ 成功 (${r.success.length}):\n${r.success.map(s => '  • ' + s).join('\n')}\n`;  
        reportText += `⏭ 跳过 (${r.skipped.length}):\n${r.skipped.map(s => '  • ' + s).join('\n')}\n`;  
        reportText += `❌ 失败 (${r.failed.length}):\n${r.failed.map(s => '  • ' + s).join('\n')}\n\n`;  
    });  
  
    // 详细本地通知（副标题显示简要统计，内容显示完整报告）  
    $notification.post(  
        'DNSHE Renew',  
        `成功:${totalSuccess} 跳过:${totalSkipped} 失败:${totalFailed}`,  
        reportText  
    );  
  
    // 构建 HTML 报告（用于 Telegram/PushPlus）  
    let htmlReport = '<b>DNSHE 续期报告</b>\n\n';  
    report.forEach(r => {  
        htmlReport += `<b>=== ${r.account} ===</b>\n`;  
        if (r.error) { htmlReport += `❌ ${r.error}\n\n`; return; }  
        htmlReport += `✅ 成功 (${r.success.length}):\n${r.success.map(s => '  • ' + s).join('\n')}\n`;  
        htmlReport += `⏭ 跳过 (${r.skipped.length}):\n${r.skipped.map(s => '  • ' + s).join('\n')}\n`;  
        htmlReport += `❌ 失败 (${r.failed.length}):\n${r.failed.map(s => '  • ' + s).join('\n')}\n\n`;  
    });  
  
    if (tgBot && tgChatid) sendTelegram(tgBot, tgChatid, htmlReport);  
    if (pushplusToken) sendPushPlus(pushplusToken, htmlReport, 'DNSHE Renew');  
  
    $done();  
}  
  
main().catch(e => {  
    $notification.post('DNSHE Renew Error', e.message || e, '');  
    $done();  
});  
