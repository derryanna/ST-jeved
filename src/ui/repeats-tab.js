import { REPLIES_MINED, chatRepeats, forgetRepeats, hotRepeats, repeatsText } from '../repeats.js';
import { toast } from '../toast.js';
import { actions, button, chip, help, node, section, text } from './dom.js';

function phraseChip(item, suffix = '') {
    const element = chip(`${item.text}${suffix} ×${item.df}`, item.recent ? 'warn' : '', item.recent
        ? `In ${item.df} of the mined replies, and in one of the last 10.`
        : `In ${item.df} of the mined replies, none of them recent.`);
    element.classList.add('jeved-repeat');
    return element;
}

function cloud(items, suffix = '') {
    const element = node('div', 'jeved-repeats');
    element.append(...items.map(item => phraseChip(item, suffix)));
    return element;
}

async function copyList() {
    const list = repeatsText('list');
    if (!list) {
        toast('info', 'Nothing to copy yet.');
        return;
    }
    const lines = list.split(', ').map(item => item.replace(/^«|»$/g, ''));
    try {
        await navigator.clipboard.writeText(lines.join('\n'));
        toast('success', `Copied ${lines.length} phrases.`);
    } catch {
        toast('info', lines.join('\n'));
    }
}

export function repeatsTab(host) {
    const element = node('div', 'jeved-repeats-tab');

    function draw() {
        const report = chatRepeats();
        const children = [
            help(`Plain counting over the last ${REPLIES_MINED} narrator replies of this chat. No API call. ×N is the number of different replies a phrase appears in. A highlighted phrase was in one of the last 10 replies.`),
        ];
        if (!report || !report.replies) {
            children.push(help('This chat has no long narrator replies yet.'));
        } else if (!report.phrases.length && !report.openers.length) {
            children.push(help(`Mined ${report.replies} replies. Nothing comes back three times yet.`));
        } else {
            children.push(text('div', 'jeved-readout', `Mined ${report.replies} replies.`));
            if (report.phrases.length) {
                children.push(text('div', 'jeved-list-caption', 'Phrases'), cloud(report.phrases));
            }
            if (report.openers.length) {
                children.push(text('div', 'jeved-list-caption', 'Reply openers'), cloud(report.openers, '…'));
            }
            if (report.constructions.length) {
                children.push(text('div', 'jeved-list-caption', 'Constructions, per reply'), text('div', 'jeved-hint',
                    report.constructions.map(item => `${item.name} ${item.perReply}`).join(' · ')));
            }
        }
        const sentence = repeatsText();
        const macro = section(
            'Macro',
            help('{{jeved-repeats}} gives the sentence below to a rule instruction, a Quick Reply or an STscript. It is empty while nothing hot repeats. {{jeved-repeats::list}} gives the bare phrases. The Echo rule of the Director preset uses it.'),
            text('div', 'jeved-excerpt', sentence || '(empty right now: no phrase is both frequent and recent)'),
        );
        children.push(actions(
            button('Copy list', 'Copy the hot phrases, one per line, for a ban list', copyList),
            button('Recount', 'Mine the chat again', () => {
                forgetRepeats();
                draw();
            }),
        ));
        element.replaceChildren(section('Repeats', ...children), macro);
    }

    draw();
    return {
        element,
        refresh: draw,
        leave: async () => true,
    };
}

export { hotRepeats };
