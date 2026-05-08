/**
 * DNSHE 免费域名批量续期脚本 (Loon Cron)
 * 增加 console.log 日志输出，可在 Loon 日志页面查看
 * 
 * 参数格式（argument）：
 * 账户一:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;账户二:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa
 * （名称:APIKey:APISecret，多个账户用英文分号分隔）
 */
const API_BASE = "https://api005.dnshe.com/index.php?m=domain_hub";
const PER_PAGE = 200;

console.log("========== DNSHE 续期脚本开始 ==========");
console.log("执行时间: " + new Date().toLocaleString());

// 解析账户信息
let accounts = [];
try {
    if (typeof $argument !== "string" || $argument.trim() === "") {
        throw new Error("未配置账户参数");
    }
    accounts = $argument.split(";").filter(s => s.trim()).map(item => {
        const parts = item.split(":");
        if (parts.length !== 3) throw new Error("账户格式错误: " + item);
        const [name, key, secret] = parts.map(s => s.trim());
        if (!name || !key || !secret) throw new Error("账户信息不完整");
        return { name, key, secret };
    });
    console.log(`解析到 ${accounts.length} 个账户: ${accounts.map(a => a.name).join(", ")}`);
    if (accounts.length === 0) throw new Error("无有效账户");
} catch (e) {
    console.log("账户解析失败: " + e.message);
    $notification.post("DNSHE续期配置错误", e.message, "");
    $done();
}

function httpRequest(method, endpoint, action, data, key, secret) {
    const url = `${API_BASE}&endpoint=${endpoint}&action=${action}`;
    const headers = {
        "X-API-Key": key,
        "X-API-Secret": secret,
        "Content-Type": "application/json"
    };
    return new Promise((resolve, reject) => {
        const params = { url, headers, timeout: 15000 };
        if (method === "POST" || method === "PUT") {
            params.body = JSON.stringify(data || {});
            console.log(`  请求: POST ${action} for subdomain_id=${data?.subdomain_id}`);
        } else {
            console.log(`  请求: GET ${action} (endpoint=${endpoint})`);
        }
        $httpClient[method.toLowerCase()](params, (err, resp, body) => {
            if (err) {
                console.log(`  HTTP错误: ${err}`);
                return reject(err);
            }
            try {
                const json = JSON.parse(body);
                resolve(json);
            } catch (e) {
                console.log(`  JSON解析失败: ${body}`);
                reject("JSON解析失败: " + body);
            }
        });
    });
}

async function getAllSubdomains(key, secret) {
    let allSubdomains = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
        const url = `${API_BASE}&endpoint=subdomains&action=list&page=${page}&per_page=${PER_PAGE}`;
        const headers = { "X-API-Key": key, "X-API-Secret": secret };
        console.log(`  获取子域名列表 第${page}页...`);
        const respJson = await new Promise((resolve, reject) => {
            $httpClient.get({ url, headers, timeout: 15000 }, (err, resp, body) => {
                if (err) return reject(err);
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject("分页解析失败: " + body);
                }
            });
        });
        if (!respJson.success) {
            throw new Error(`获取子域名列表失败: ${respJson.message || JSON.stringify(respJson)}`);
        }
        const count = respJson.subdomains?.length || 0;
        console.log(`  第${page}页获取到 ${count} 个域名`);
        if (respJson.subdomains && Array.isArray(respJson.subdomains)) {
            allSubdomains = allSubdomains.concat(respJson.subdomains);
        }
        if (respJson.pagination && respJson.pagination.has_more) {
            page++;
        } else {
            hasMore = false;
        }
        await new Promise(r => setTimeout(r, 300));
    }
    console.log(`  总共获取到 ${allSubdomains.length} 个域名`);
    return allSubdomains;
}

async function renewDomain(subdomainId, key, secret) {
    const data = { subdomain_id: subdomainId };
    return await httpRequest("POST", "subdomains", "renew", data, key, secret);
}

async function processAccount(account) {
    const { name, key, secret } = account;
    console.log(`\n--- 开始处理账户: ${name} ---`);
    const result = {
        name,
        success: [],
        skipped: [],
        failed: [],
        summary: { success: 0, skipped: 0, failed: 0 }
    };
    try {
        const subdomains = await getAllSubdomains(key, secret);
        const activeSubs = subdomains.filter(d => d.status === "active");
        console.log(`  活跃域名数量: ${activeSubs.length}`);
        for (const sub of activeSubs) {
            const domainName = sub.full_domain || sub.subdomain + "." + sub.rootdomain;
            console.log(`  续期域名: ${domainName} (id=${sub.id})`);
            try {
                const res = await renewDomain(sub.id, key, secret);
                if (res.success) {
                    const newExpiry = res.new_expires_at || "未知";
                    const msg = `${domainName} → 续期至 ${newExpiry}`;
                    console.log(`    ✅ 成功: ${msg}`);
                    result.success.push(msg);
                    result.summary.success++;
                } else {
                    const errorCode = res.error_code || "";
                    const msg = res.message || JSON.stringify(res);
                    if (errorCode === "renewal_not_yet_available" || errorCode === "renewal_window_not_open") {
                        console.log(`    ⏭️ 跳过: ${domainName} (未到续期窗口)`);
                        result.skipped.push(`${domainName} (尚未进入续期窗口)`);
                        result.summary.skipped++;
                    } else {
                        console.log(`    ❌ 失败: ${domainName} - ${msg}`);
                        result.failed.push(`${domainName}: ${msg}`);
                        result.summary.failed++;
                    }
                }
            } catch (e) {
                console.log(`    ❌ 异常: ${domainName} - ${e}`);
                result.failed.push(`${domainName}: 请求异常 - ${e}`);
                result.summary.failed++;
            }
            await new Promise(r => setTimeout(r, 500));
        }
    } catch (e) {
        console.log(`  获取域名列表失败: ${e}`);
        result.failed.push(`获取域名列表失败: ${e}`);
        result.summary.failed++;
    }
    console.log(`--- 账户 ${name} 结果: ✅${result.summary.success} ⏭️${result.summary.skipped} ❌${result.summary.failed} ---`);
    return result;
}

function formatReport(allResults) {
    const lines = [];
    const total = { success: 0, skipped: 0, failed: 0 };
    for (const res of allResults) {
        lines.push(`【${res.name}】`);
        if (res.success.length > 0) {
            lines.push(`✅ 成功 (${res.summary.success}):`);
            res.success.forEach(s => lines.push(`  ${s}`));
        }
        if (res.skipped.length > 0) {
            lines.push(`⏭️ 跳过 (${res.summary.skipped}):`);
            res.skipped.forEach(s => lines.push(`  ${s}`));
        }
        if (res.failed.length > 0) {
            lines.push(`❌ 失败 (${res.summary.failed}):`);
            res.failed.forEach(s => lines.push(`  ${s}`));
        }
        lines.push("");
        total.success += res.summary.success;
        total.skipped += res.summary.skipped;
        total.failed += res.summary.failed;
    }
    const summaryLine = `总计: ✅${total.success} ⏭️${total.skipped} ❌${total.failed}`;
    return { content: lines.join("\n"), summary: summaryLine };
}

(async () => {
    const results = [];
    for (const acc of accounts) {
        const res = await processAccount(acc);
        results.push(res);
    }
    const { content, summary } = formatReport(results);
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    console.log("\n========== 续期报告 ==========");
    console.log(content);
    console.log("==============================");
    $notification.post("DNSHE域名续期报告", `${dateStr}  ${summary}`, content);
    console.log("脚本执行完毕，即将退出");
    $done();
})();
