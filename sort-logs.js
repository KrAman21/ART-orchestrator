import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputPath = path.join(__dirname, 'data', 'logs.json');
const outputPath = inputPath;

const shouldRemoveDuplicates = process.argv.includes('--remove-duplicates');
const shouldApplyCustomLogic = process.argv.includes('--custom');

const VALID_LABELS = ['APP', 'LENDER', 'GATEWAY'];

function getSourceDestination(label, logTag) {
    if (label === 'APP') {
        const isIncoming = logTag.endsWith('Request') || logTag.endsWith('INCOMING');
        const isOutgoing = logTag.endsWith('Response') || logTag.endsWith('OUTGOING');
        if (isIncoming) return 'APP_WRAPPER';
        if (isOutgoing) return 'WRAPPER_APP';
    }
    if (label === 'LENDER') {
        const isIncoming = logTag.endsWith('Response') || logTag.endsWith('INCOMING');
        const isOutgoing = logTag.endsWith('Request') || logTag.endsWith('OUTGOING');
        if (isIncoming) return 'GW_LSP';
        if (isOutgoing) return 'LSP_GW';
    }
    if (label === 'GATEWAY') {
        const isIncoming = logTag.endsWith('Response') || logTag.endsWith('INCOMING');
        const isOutgoing = logTag.endsWith('Request') || logTag.endsWith('OUTGOING');
        if (isIncoming) return 'LENDER_GW';
        if (isOutgoing) return 'GW_LENDER';
    }
    return undefined;
}

const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const sorted = data.sort((a, b) => {
    const timeA = a.message?.created_at || '';
    const timeB = b.message?.created_at || '';
    return new Date(timeA) - new Date(timeB);
});

let result = sorted;

if (shouldRemoveDuplicates) {
    const seen = new Set();
    result = result.filter(item => {
        const key = `${item.messageNumber}-${item.xRequestId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    const removedCount = sorted.length - result.length;
    console.log(`Removed ${removedCount} duplicate entries`);
}

if (shouldApplyCustomLogic) {
    result = result.filter(item => {
        const label = item.message?.label;
        const logTag = item.message?.log_tag;
        return VALID_LABELS.includes(label) && logTag != null && logTag != 'ThemisGenerateOffersResponse Response';
    });

    result.forEach(item => {
        const label = item.message?.label;
        const logTag = item.message?.log_tag;
        item.message.source_destination = getSourceDestination(label, logTag);
    });

    console.log(`Filtered and annotated entries`);
}

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

console.log(`Updated ${result.length} entries in-place`);
