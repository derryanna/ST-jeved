// Repeat miner: plain counting in the browser, no model and no API call.
// Reads the narrator replies of the open chat and finds phrases, reply openers and stock
// constructions that come back across different replies. Ported from the jev-sensors strip.
import { currentChat, isNarrator } from './store.js';
import { hashText } from './util.js';

export const REPLIES_MINED = 60;
const MIN_LENGTH = 200;
const RECENT = 10;
const HOT_DF = 4;
const HOT_PHRASES = 8;
const HOT_OPENERS = 2;

const RU_STOP = ('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему ' +
    'теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ей может они тут где есть надо ней для мы тебя их ' +
    'чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой ним здесь этом один почти мой тем чтобы нее были куда ' +
    'зачем всех можно при об хоть над больше тот через эти нас про всего них какая много разве эту моя свою этой перед лучше чуть том такой им более всю между ' +
    'это эта свой своей своих свои её').split(' ');
const EN_STOP = ('the a an and or but of to in on at by for with from as is are was were be been being it its this that these those he she they them his her ' +
    'their him you your i me my we our us not no so if then than too very just into onto over under out up down off about after before again through ' +
    'there here where when while who whom which what why how all any both each few more most other some such only own same can will would could should ' +
    'do does did done have has had having s t').split(' ');
const STOP = new Set([...RU_STOP, ...EN_STOP]);

const RU_END = /(ами|ями|ого|его|ому|ему|ыми|ими|ешь|ишь|ете|ите|ала|яла|или|ыли|ило|ыло|ало|ела|ели|ело|ула|ули|уло|ая|яя|ое|ее|ые|ие|ый|ий|ой|ым|им|ом|ем|ах|ях|ов|ев|ей|ам|ям|ую|юю|ть|ла|ло|ли|ил|ыл|ал|ел|ул|ся|сь|а|я|о|е|ы|и|у|ю|ь|й)$/;
const EN_END = /(ing|edly|ed|es|s|ly)$/;

function stem(word) {
    const end = /[а-я]/.test(word) ? RU_END : EN_END;
    for (let i = 0; i < 2; i++) {
        const short = word.replace(end, '');
        if (short.length < 3 || short === word) {
            break;
        }
        word = short;
    }
    return word;
}

const sentences = text => text.split(/[.!?…]+["»”)]*\s+|\n+/).map(s => s.trim()).filter(Boolean);
const words = sentence => (sentence.toLowerCase().replace(/ё/g, 'е').match(/[а-яa-z]+(?:-[а-яa-z]+)?/g) || []);

const CONSTRUCTIONS = [
    { name: '«не X, а Y»', re: /(?:^|[\s«(])не\s+[^.,!?\n—]{1,40}(?:,|\s—)\s*а\s/gi },
    { name: '«словно / будто»', re: /(?:^|[^а-яё])(словно|будто|точно так же, как)(?![а-яё])/gi },
    { name: '«что-то / где-то / какой-то»', re: /(?:^|[^а-яё])(что|где|как|какой|какая|какое|какие|почему|куда|когда)-то(?![а-яё])/gi },
    { name: '«на секунду / мгновение / миг»', re: /на\s+(долю\s+)?(секунд[уы]|мгновени[ея]|миг)(?![а-яё])/gi },
    { name: '"not X, but Y"', re: /(?:^|[\s(])not\s+[^.,!?\n]{1,40},\s*but\s/gi },
    { name: '"something / somewhere"', re: /(?:^|[^a-z])some(thing|where|how|one)(?![a-z])/gi },
];

// Reply text -> prose only: no plan/info blocks, no html, no date header, no tracker footer.
export function cleanReply(raw) {
    let text = String(raw ?? '')
        .replace(/<(style|script|details|plan|info|think|thinking)[\s\S]*?<\/\1>/gi, '')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<[^>]+>/g, '')
        .trim();
    const nl = text.indexOf('\n');
    if (nl > 0 && (text.slice(0, nl).match(/\|/g) || []).length >= 3) {
        text = text.slice(nl + 1); // date | place | weather header
    }
    text = text.replace(/\n-{3,}[ \t]*\n[\s\S]*$/, m => (/\p{Extended_Pictographic}/u.test(m) ? '' : m)); // --- + emoji tracker footer
    text = text.split('\n').filter(line => !/^\s*\p{Extended_Pictographic}/u.test(line)).join('\n'); // stray tracker lines
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function mineRepeats(texts, { minDf = 3, top = 12 } = {}) {
    const count = texts.length;
    const grams = new Map();
    const openers = new Map();
    texts.forEach((text, doc) => {
        sentences(text).forEach((sentence, si) => {
            const w = words(sentence);
            const st = w.map(stem);
            if (si === 0 && w.length >= 2) {
                const key = st.slice(0, 2).join(' ');
                const opener = openers.get(key) || { docs: new Set(), samples: [] };
                opener.docs.add(doc);
                opener.samples.push(sentence.split(/\s+/).slice(0, 6).join(' '));
                openers.set(key, opener);
            }
            for (let n = 2; n <= 5; n++) {
                for (let i = 0; i + n <= w.length; i++) {
                    const content = w.slice(i, i + n).filter(x => !STOP.has(x) && x.length > 2).length;
                    if (content < 2 || (STOP.has(w[i]) && n === 2) || STOP.has(w[i + n - 1])) {
                        continue;
                    }
                    const key = st.slice(i, i + n).join(' ');
                    const gram = grams.get(key) || { n, content, docs: new Set(), forms: new Map() };
                    gram.docs.add(doc);
                    const surface = w.slice(i, i + n).join(' ');
                    gram.forms.set(surface, (gram.forms.get(surface) || 0) + 1);
                    grams.set(key, gram);
                }
            }
        });
    });
    const list = [...grams.entries()]
        .filter(([, gram]) => gram.docs.size >= minDf)
        .map(([key, gram]) => ({
            key, n: gram.n, df: gram.docs.size, content: gram.content, last: Math.max(...gram.docs),
            text: [...gram.forms.entries()].sort((a, b) => b[1] - a[1])[0][0],
        }));
    // a shorter phrase that lives almost only inside a longer kept one adds nothing
    list.sort((a, b) => b.n - a.n || b.df - a.df);
    const kept = [];
    for (const gram of list) {
        if (!kept.some(k => k.n > gram.n && k.key.includes(gram.key) && k.df >= gram.df * 0.7)) {
            kept.push(gram);
        }
    }
    const phrases = kept.sort((a, b) => b.df * b.content - a.df * a.content).slice(0, top)
        .map(gram => ({ text: gram.text, df: gram.df, recent: count - 1 - gram.last < RECENT }));
    const opens = [...openers.values()].filter(o => o.docs.size >= minDf)
        .sort((a, b) => b.docs.size - a.docs.size).slice(0, 6)
        .map(o => ({ text: o.samples[o.samples.length - 1], df: o.docs.size, recent: count - 1 - Math.max(...o.docs) < RECENT }));
    const joined = texts.join('\n');
    const constructions = CONSTRUCTIONS
        .map(c => ({ name: c.name, perReply: +(((joined.match(c.re) || []).length) / Math.max(count, 1)).toFixed(1) }))
        .filter(c => c.perReply > 0);
    return { replies: count, phrases, openers: opens, constructions };
}

export function narratorTexts(chat = currentChat()) {
    return (Array.isArray(chat) ? chat : [])
        .filter(isNarrator)
        .map(message => cleanReply(message.mes))
        .filter(text => text.length >= MIN_LENGTH && !/^\[?\s*OOC/i.test(text))
        .slice(-REPLIES_MINED);
}

let cache = { key: '', report: null };

export function chatRepeats(chat = currentChat()) {
    const texts = narratorTexts(chat);
    const key = `${texts.length}:${hashText(texts.join('\n'))}`;
    if (cache.key !== key) {
        cache = { key, report: mineRepeats(texts) };
    }
    return cache.report;
}

export function forgetRepeats() {
    cache = { key: '', report: null };
}

export function hotRepeats(report) {
    if (!report) {
        return { phrases: [], openers: [] };
    }
    return {
        phrases: report.phrases.filter(p => p.recent && p.df >= HOT_DF).slice(0, HOT_PHRASES),
        openers: report.openers.filter(o => o.recent).slice(0, HOT_OPENERS),
    };
}

const quoted = items => items.map(item => `«${item}»`).join(', ');

// {{jeved-repeats}}: one sentence for an instruction. {{jeved-repeats::list}}: the bare phrases.
export function repeatsText(mode = '', chat = currentChat()) {
    const hot = hotRepeats(chatRepeats(chat));
    const phrases = hot.phrases.map(p => p.text);
    const openers = hot.openers.map(o => `${o.text}…`);
    if (String(mode ?? '').trim().toLowerCase() === 'list') {
        return quoted([...phrases, ...openers]);
    }
    if (!phrases.length && !openers.length) {
        return '';
    }
    let line = phrases.length ? `These phrases came back in several recent replies: ${quoted(phrases)}.` : '';
    if (openers.length) {
        line += `${line ? ' ' : ''}Replies already opened with: ${quoted(openers)}.`;
    }
    return `${line} Use none of them here; find another detail, another gesture, another rhythm.`;
}
