import type { UAClass } from '../types.js';
export const crawlerPatterns: Array<[
    string,
    RegExp,
    string[]
]> = [
    ['google', /Googlebot|Google-InspectionTool|GoogleOther/i, ['googlebot.com', 'google.com', 'googleusercontent.com']],
    ['bing', /bingbot/i, ['search.msn.com']], ['apple', /Applebot/i, ['applebot.apple.com']],
    ['duckduckgo', /DuckDuckBot/i, ['duckduckgo.com']], ['yandex', /YandexBot/i, ['yandex.ru', 'yandex.net', 'yandex.com']],
    ['baidu', /Baiduspider/i, ['baidu.com', 'baidu.jp']],
];
export function claimedCrawler(ua: string): string | undefined { return crawlerPatterns.find(([, re]) => re.test(ua))?.[0]; }
export function classifyUA(ua: string): UAClass {
    if (/GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-Web|Claude-User|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|cohere-ai/i.test(ua))
        return 'declared_ai_crawler';
    if (!ua || /curl\/|python-requests|python-httpx|node-fetch|axios\/|Go-http-client|HeadlessChrome|wget\/|undici/i.test(ua))
        return 'automation';
    if (/Mozilla\/|Chrome\/|Safari\/|Firefox\/|Edg\//i.test(ua))
        return 'browser';
    return 'unknown';
}
