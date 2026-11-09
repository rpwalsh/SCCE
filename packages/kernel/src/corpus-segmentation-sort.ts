// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorpusSegmentationScratch, CorpusSegmentationScratchRow } from "./corpus-segmentation-cursor.js";

export function segmentationOrdinalKey(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid segmentation scratch ordinal");
  return String(ordinal).padStart(String(Number.MAX_SAFE_INTEGER).length, "0");
}

export async function* segmentationScratchRows(store: CorpusSegmentationScratch, collection: string): AsyncGenerator<CorpusSegmentationScratchRow> {
  for await (const page of store.pages({ collection, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) for (const row of page) yield row;
}

/** Stable bounded multiway external merge; input groups remain contiguous to preserve every comparator tie. */
export async function sortSegmentationScratch(store: CorpusSegmentationScratch, source: string, target: string,
  compare: (left: CorpusSegmentationScratchRow, right: CorpusSegmentationScratchRow) => number): Promise<void> {
  if (source === target) throw new Error("segmentation external sort requires a distinct destination");
  const headBytes = Uint32Array.BYTES_PER_ELEMENT;
  const budget = store.sortMergeBudget ?? { maxResidentBytes: store.maxPageBytes * 3 + headBytes * 2,
    residentBytesPerInput: store.maxPageBytes, residentOutputBytes: store.maxPageBytes };
  if (![budget.maxResidentBytes,budget.residentBytesPerInput,budget.residentOutputBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || budget.residentBytesPerInput < store.maxPageBytes || budget.residentOutputBytes < store.maxPageBytes) throw new Error("invalid segmentation sort working budget");
  const fanIn = Math.min(0xffffffff, Math.floor((budget.maxResidentBytes - budget.residentOutputBytes) / (budget.residentBytesPerInput + headBytes)));
  if (fanIn < 2) throw new Error("segmentation sort working budget cannot hold two input pages and its output");
  let runCount = 0;
  const runName = (level: number, ordinal: number) => `${target}.sort.${level}.${ordinal}`;
  for await (const page of store.pages({ collection: source, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) {
    if (!page.length) continue;
    const name = runName(0, runCount++);
    await store.deleteCollection(name);
    await store.putMany(name, [...page].sort(compare).map((row, index) => ({ ...row, orderKey: segmentationOrdinalKey(index) })));
  }
  let level = 0;
  while (runCount > 1) {
    let nextRun = 0;
    for (let index = 0; index < runCount; index += fanIn) {
      const count = Math.min(fanIn,runCount-index);
      const names = Array.from({length:count},(_,input)=>runName(level,index+input));
      const inputs = names.map(name=>segmentationScratchRows(store,name));
      const destination = runName(level + 1, nextRun++);
      await store.deleteCollection(destination);
      const heads: Array<CorpusSegmentationScratchRow | undefined> = new Array(count);
      // Heads reference their charged input pages; the only separate heap storage is these fixed-width indices.
      const heap = new Uint32Array(count); let heapSize = 0;
      const before = (left:number,right:number) => { const order=compare(heads[left]!,heads[right]!);return order<0 || order===0&&left<right; };
      const push = (input:number) => { let position=heapSize++;while(position){const parent=(position-1)>>>1;
        if(!before(input,heap[parent]!))break;heap[position]=heap[parent]!;position=parent;}heap[position]=input; };
      const down = () => { let position=0;const input=heap[0]!;for(;;){const left=position*2+1;if(left>=heapSize)break;
        const right=left+1,child=right<heapSize&&before(heap[right]!,heap[left]!)?right:left;
        if(!before(heap[child]!,input))break;heap[position]=heap[child]!;position=child;}heap[position]=input; };
      let ordinal = 0; let buffer: CorpusSegmentationScratchRow[] = []; let bytes = 0;
      const flush = async () => { if (buffer.length) await store.putMany(destination, buffer); buffer = []; bytes = 0; };
      const close = async () => { const errors:unknown[]=[];for(const input of inputs)try{await input.return(undefined);}catch(error){errors.push(error);}
        if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,"Segmentation sort input cleanup failed"); };
      try {
        for(let input=0;input<count;input++){const first=await inputs[input]!.next();if(!first.done){heads[input]=first.value;push(input);}}
        while (heapSize) {
          const input=heap[0]!,row=heads[input]!;
          const output = { ...row, orderKey: segmentationOrdinalKey(ordinal++) };
          const size = Buffer.byteLength(JSON.stringify(output));
          if (size > store.maxPageBytes) throw new Error("segmentation scratch row exceeds declared page bytes");
          if (buffer.length && (buffer.length >= store.pageRows || bytes + size > store.maxPageBytes)) await flush();
          buffer.push(output); bytes += size;
          const next=await inputs[input]!.next();
          if(next.done){heads[input]=undefined;heap[0]=heap[--heapSize]!;}else heads[input]=next.value;
          if(heapSize)down();
        }
        await flush();
      } catch(error) { try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"Segmentation sort merge and cleanup failed");}throw error; }
      await close();
      for(const name of names)await store.deleteCollection(name);
    }
    level++; runCount = nextRun;
  }
  await store.deleteCollection(target);
  if (!runCount) return;
  const final = runName(level, 0);
  for await (const page of store.pages({ collection: final, pageRows: store.pageRows, maxPageBytes: store.maxPageBytes })) await store.putMany(target, page);
  await store.deleteCollection(final);
}
