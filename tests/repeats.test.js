import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { hostStub } from './helpers/host.js';

const context = hostStub();

const { chatRepeats, cleanReply, forgetRepeats, hotRepeats, mineRepeats, repeatsText } = await import('../src/repeats.js');
const { fillMacros } = await import('../src/macros.js');
const { initSettings } = await import('../src/settings.js');

// Each reply gets its own filler so only the planted phrases repeat across replies.
const fillers = [
    'Дождь стучал по крыше таверны, огонь в камине трещал, и кто-то за дальним столом негромко напевал старую песню про дорогу.',
    'Ветер гнал по улице обрывки бумаги, фонарь над входом мигал, а вдали лаяла собака, не переставая ни на минуту.',
    'На полке стояли пыльные бутылки, паук плёл сеть между ними, а часы на стене отставали на четверть века.',
    'Снаружи скрипели телеги, торговцы выкрикивали цены, дети гоняли обруч по мостовой, пахло хлебом и конским потом.',
];
const pad = fillers[0] + ' ';
const replies = [
    'Широкая ладонь легла на стол. Он медленно кивнул, серые глаза смотрели мимо.',
    'Широкая ладонь сжала кружку. Серые глаза не отрывались от двери.',
    'Широкая ладонь дрогнула. Хатак медленно выдохнул, серые глаза потемнели.',
    'Хатак медленно поднялся. Широкая ладонь скользнула по краю стола, серые глаза остались холодными.',
].map((text, index) => `${text} ${fillers[index]} ${fillers[index]}`);

beforeEach(() => {
    context.extensionSettings = {};
    context.chat = [];
    initSettings();
    forgetRepeats();
});

describe('mineRepeats', () => {
    it('finds a phrase that returns in several different replies, once per stem', () => {
        const report = mineRepeats(replies, { minDf: 3 });
        const texts = report.phrases.map(item => item.text);
        assert.ok(texts.includes('широкая ладонь'), texts.join(' | '));
        assert.ok(texts.includes('серые глаза'), texts.join(' | '));
        assert.equal(report.phrases.find(item => item.text === 'широкая ладонь').df, 4);
        assert.equal(report.replies, 4);
    });

    it('finds the reply openers and marks recent ones', () => {
        const report = mineRepeats(replies, { minDf: 3 });
        assert.equal(report.openers.length, 1);
        assert.match(report.openers[0].text, /^Широкая ладонь/);
        assert.equal(report.openers[0].recent, true);
    });

    it('gives an empty report for nothing', () => {
        assert.deepEqual(mineRepeats([]), { replies: 0, phrases: [], openers: [], constructions: [] });
    });

    it('works on English too', () => {
        const english = [
            'A slow smile crept across his face. Something shifted in the air between them.',
            'Something shifted in the air. A slow smile crept over his face again.',
            'A slow smile crept across her face. Something shifted in the air.',
        ].map(text => text + ' ' + 'More prose follows here so the reply is long enough to count. '.repeat(4));
        const texts = mineRepeats(english, { minDf: 3 }).phrases.map(item => item.text);
        assert.ok(texts.some(text => text.includes('slow smile')), texts.join(' | '));
    });
});

describe('cleanReply', () => {
    it('drops hidden blocks, html, a header line and an emoji tracker footer', () => {
        const raw = '12 мая | 20:00 | Таверна | дождь\n<plan>secret</plan><b>Текст</b> ответа.\n\n---\n🕐 12:00 📍 бар';
        assert.equal(cleanReply(raw), 'Текст ответа.');
    });
});

describe('the repeats of the open chat', () => {
    it('reads only long narrator replies and skips OOC', () => {
        context.chat = [
            user('hello'),
            ...replies.flatMap(text => [narrator(text), user('go on')]),
            narrator('[OOC: short note] ' + pad.repeat(3)),
            narrator('short'),
        ];
        const report = chatRepeats();
        assert.equal(report.replies, 4);
        const hot = hotRepeats(report);
        assert.ok(hot.phrases.some(item => item.text === 'широкая ладонь'));
    });

    it('caches by chat shape and forgets on demand', () => {
        context.chat = replies.map(narrator);
        const first = chatRepeats();
        assert.equal(chatRepeats(), first);
        context.chat = [...context.chat, narrator(replies[0])];
        assert.notEqual(chatRepeats(), first);
        const again = chatRepeats();
        forgetRepeats();
        assert.notEqual(chatRepeats(), again);
    });

    it('recounts when a reply in the middle of the chat is edited', () => {
        context.chat = replies.map(narrator);
        const before = chatRepeats();
        context.chat[1].mes = fillers[1].repeat(3);
        const after = chatRepeats();
        assert.notEqual(after, before);
        assert.equal(after.phrases.find(item => item.text === 'широкая ладонь').df, 3);
    });
});

describe('the {{jeved-repeats}} macro', () => {
    it('is empty while nothing is both frequent and recent', () => {
        context.chat = [narrator(replies[0])];
        assert.equal(repeatsText(), '');
        assert.equal(repeatsText('list'), '');
        assert.equal(fillMacros('a {{jeved-repeats}} b'), 'a  b');
    });

    it('names the hot phrases in one sentence, or as a bare list', () => {
        context.chat = replies.map(narrator);
        const sentence = repeatsText();
        assert.match(sentence, /^These phrases came back in several recent replies: /);
        assert.match(sentence, /«широкая ладонь»/);
        assert.match(sentence, /Replies already opened with: «Широкая ладонь [^»]*…»/);
        assert.match(sentence, /Use none of them here/);
        const list = repeatsText('list');
        assert.match(list, /^«/);
        assert.ok(!/These phrases/.test(list));
        assert.equal(fillMacros('x {{jeved-repeats::list}}'), `x ${list}`);
        assert.equal(fillMacros('x {{jeved-repeats}}'), `x ${sentence}`);
    });
});
