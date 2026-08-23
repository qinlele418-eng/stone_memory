import { callZai } from './zai.mjs';

const result = await callZai({ prompt: '只回复 OK。不要输出其它内容。', maxTokens: 32, thinking: { type: 'disabled' } });
if (!result?.text) throw new Error('Z.AI smoke handshake 没有返回文本');
process.stdout.write(`Z.AI smoke handshake 成功（model=${result.model}）\n`);
