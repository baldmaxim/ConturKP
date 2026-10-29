// S18-32: предмет вопроса и письменное основание. Эти правила не объявляются общим NLI-проверяющим:
// сложный анализ допускает только извлекаемые цитаты; тип документа и роль величины проверяются отдельно.
import { compareQuantities, extractQuantities } from './claimNumbers.ts';
import type { IDraftClaim, IPacketItem } from './claimChecks.ts';
import type { IPacketCandidate } from './packet.ts';
import { questionDates } from './planner.ts';

export type SourceFamily = 'proposal' | 'contract' | 'terms' | 'award' | 'act' | 'technical' | 'calculation' | 'other';
type Topic = 'advance' | 'retention' | 'award' | 'price';
const clean = (s: string): string => s.toLowerCase().replaceAll('ё','е').replace(/[«»“”"']/gu,'').replace(/\s+/gu,' ').trim();
const OFFER = /коммерческ\p{L}*\s+предложен|оферт|(?:^|[^\p{L}])кп(?:$|[^\p{L}])/iu;
const CONTRACT = /договор|(?:^|[^\p{L}])дгп(?:$|[^\p{L}])/iu;
const AWARD = /(?:протокол|выписк)[\s\S]{0,120}(?:тендерн|комитет|(?:^|[^\p{L}])тк(?:$|[^\p{L}]))|тендерн\p{L}*\s+комитет/iu;
const ACT = /акт[\s\S]{0,80}(?:приемк|приёмк|выполненн\p{L}*\s+работ)|^\s*акт\s*(?:№|от\s|\d)/iu;
const PRIMARY: Record<Topic, RegExp> = { advance:/аванс/iu, retention:/удержан|отделоч/iu, award:/победит|признать|решени|стоимост|вознагражден|инженер/iu, price:/стоимост\p{L}*\s+(?:наш\p{L}*\s+)?предложен|общ\p{L}*\s+стоимост|^\s*(?:итого|всего)\s*(?:\([^)]*\))?\s*[:|]?\s*\d|цен\p{L}*\s+предложен/ium };
const PRICE_SEARCH = 'стоимост.{0,40}предложен|общ.{0,20}стоимост|^[[:space:]]*(итого|всего)[[:space:]]*(\\([^)]*\\))?[[:space:]:|]*[0-9]';

// Ставка начисления и доля возврата удержанного — разные роли процента.
const retentionFacet = (text: string): string | null => {
  const rate = /удерживает[\s\S]{0,80}гарантийн\p{L}*\s+удержан|гарантийн\p{L}*\s+удержан\p{L}*\s*[–—-]\s*\d/iu.test(text)
    && extractQuantities(text).some(q=>q.unit==='percent');
  if (rate) return /СМР/iu.test(text) ? 'rate:mixed' : /за\s+исключением\s+отделоч|исключая\s+отделоч/iu.test(text) ? 'rate:construction' : /отделоч/iu.test(text) ? 'rate:finishing' : 'rate:construction';
  if (/(?:^|\n)\s*(?:\d+[.\d)]*\s*)?отделочн\p{L}*\s+работ\p{L}*[^.\n]{0,80}[–—-]/iu.test(text)) {
    return /квартир/iu.test(text) ? 'definition:apartments' : /МОП/iu.test(text) ? 'definition:mop' : 'definition:general';
  }
  return null;
};

export const sourceFamily = (title = '', text = ''): SourceFamily => {
  title=title.replaceAll('_',' ');
  // Содержание акта не становится протоколом от переименования файла.
  if (/^\s*акт[\s\S]{0,100}(?:приемк|приёмк|выполненн)/iu.test(text) || ACT.test(title)) return 'act';
  if (AWARD.test(title)) return 'award';
  if (/график|перечень|процедур|форма\s+договора/iu.test(title)) return 'other';
  if (/существенн\p{L}*\s+услови[\s\S]{0,60}(?:генподряд|дгп|договор)/iu.test(title)) return 'terms';
  if (OFFER.test(title)) return 'proposal';
  if (/(?:^|[^\p{L}])рср(?:$|[^\p{L}])|расч[её]т\p{L}*\s+стоимост/iu.test(title)) return 'calculation';
  if (CONTRACT.test(title)) return 'contract';
  if (/^\s*(?:выписка\s+из\s+протокола|протокол\s+тендерного\s+комитета)/iu.test(text) && AWARD.test(text.slice(0,500))) return 'award';
  if (/(?:^|[^\p{L}])пд(?:$|[^\p{L}])|проектн\p{L}*\s+документаци/iu.test(title)) return 'technical';
  if (/^\s*коммерческ\p{L}*\s+предложен/iu.test(text)) return 'proposal';
  return 'other';
};

// Только соседние письменные блоки одного документа/прогона и одной страницы.
// Строчная буква продолжает незавершённую строку; текст не склеивается в новое утверждение.
type PositionedSource = Pick<IPacketItem,'fragmentId'|'text'|'documentTitle'|'documentKey'|'sourceUnitId'|'origin'|'sourceOrder'>;
export const answerContinuationGroups = (items: readonly PositionedSource[]): Map<string,string[]> => {
  const eligible=items.filter(i=>i.sourceOrder && i.sourceOrder.part===0 && (i.sourceOrder.total??1)===1 && ['document_text','recognized_text'].includes(i.origin) && sourceFamily(i.documentTitle,i.text)==='award');
  const key=(i:PositionedSource,o=i.sourceOrder!)=>`${i.documentKey}:${i.sourceUnitId}:${o.page}:${o.ordinal}:${o.part}`;
  const byPosition=new Map(eligible.map(i=>[key(i),i]));
  const next=(i:PositionedSource)=>byPosition.get(key(i,{...i.sourceOrder!,part:i.sourceOrder!.part+1})) ?? byPosition.get(key(i,{...i.sourceOrder!,ordinal:i.sourceOrder!.ordinal+1,part:0}));
  const joins=(a:PositionedSource,b:PositionedSource|undefined)=>Boolean(b && !/[.!?;]$/u.test(a.text.trim()) && /^[а-яё]/u.test(b.text.trim()));
  const incoming=new Set(eligible.filter(i=>joins(i,next(i))).map(i=>next(i)!.fragmentId));
  const groups=new Map<string,string[]>();
  for(const root of eligible.filter(i=>!incoming.has(i.fragmentId) && /^[А-ЯЁA-Z0-9]/u.test(i.text.trim()))){
    const chain=[root];while(chain.length<4 && joins(chain.at(-1)!,next(chain.at(-1)!)))chain.push(next(chain.at(-1)!)!);
    if(chain.length>1)for(const i of chain)groups.set(i.fragmentId,chain.map(e=>e.fragmentId));
  }
  return groups;
};

export const answerFocus = (question: string) => {
  const award = /результат\p{L}*\s+торг|победител\p{L}*\s+торг|протокол[\s\S]{0,80}(?:тендерн|комитет)/iu.test(question);
  const history = /(?:истори|проследи)[\s\S]{0,100}(?:стоимост|цен)|изменени[\s\S]{0,80}(?:стоимост|цен)[\s\S]{0,80}(?:подач|оферт|кп)/iu.test(question);
  const topics: Topic[] = award ? ['award'] : history ? ['price'] : (['advance','retention'] as const).filter(t => PRIMARY[t].test(question));
  const compareSources = !award && OFFER.test(question) && CONTRACT.test(question);
  const strict = Boolean(topics.length && (award || history || compareSources || /сравни|между\s+редакци/iu.test(question)));
  return { topics, history, compareSources, strict };
};

// Параметры только для отдельного поиска оснований ответа, не новая область доступа.
export const answerRetrievalPatterns = (question: string): { text: string; title: string; primary: string } | null => {
  const focus=answerFocus(question);
  if (!focus.topics.length) return null;
  if (focus.topics.includes('award')) return {text:'победит|тендерн.{0,30}комитет|генподрядн.{0,30}вознагражден',title:'протокол|выписка',primary:'победит|признат|инженер|вознагражден'};
  if (focus.history) return {text:PRICE_SEARCH,title:'коммерческ.{0,30}предложен|оферт|(^|[^а-я])кп([^а-я]|$)',primary:PRICE_SEARCH};
  return {text:focus.topics.map(t=>t==='advance'?'аванс|банковск.{0,30}гаранти':'удержан|отделоч').join('|'),title:'',primary:focus.topics.map(t=>t==='advance'?'аванс':'удерживает.{0,80}гарантийн.{0,30}удержан|гарантийн.{0,30}удержан[[:space:]–—-]*[0-9]|^[[:space:]]*отделочн.{0,50}работ.{0,50}[-–—]').join('|')};
};

const score = (c: IPacketCandidate, question: string): number => {
  const f=answerFocus(question), family=sourceFamily(c.documentTitle,c.text);
  if (f.topics.includes('award')) return family==='award' && /победит|признать|цен|стоимост|вознагражден|инженер|протокол/iu.test(c.text) ? 60 + (/(?:победит|признать)/iu.test(c.text)?30:0) : 0;
  if (f.history) {
    if (!['proposal','calculation'].includes(family) || !PRIMARY.price.test(c.text) || !extractQuantities(c.text).some(q=>q.unit==='currency'||q.unit==='number')) return 0;
    // Дата в имени помогает отбору, но не становится доказанной датой отправки.
    const title=(c.documentTitle??'').replace(/(\d{4})[-_.](\d{2})[-_.](\d{2})/gu,'$3.$2.$1');
    return 60 + (/^\s*всего/iu.test(c.text)?20:0) + (questionDates(question).some(d=>title.includes(d))?30:0);
  }
  if (f.compareSources && !['proposal','contract','terms'].includes(family)) return 0;
  if (f.compareSources && family==='contract' && /дгп|генеральн\p{L}*\s+подряд/iu.test(question) && !/дгп|генеральн\p{L}*\s+подряд|генподряд/iu.test(c.documentTitle ?? '')) return 0;
  if (f.strict && c.text.trim().length<25 && !/\d\s*%/u.test(c.text)) return 0;
  let n=0;
  for (const t of f.topics) {
    if (PRIMARY[t].test(c.text)) n+=40;
    if (t==='advance' && /банковск\p{L}*\s+гаранти/iu.test(c.text)) n+=15;
    if (t==='retention' && /отделоч/iu.test(c.text)) n+=20;
  }
  if (n && extractQuantities(c.text).some(q=>q.unit==='currency'||q.unit==='percent')) n+=30;
  if (n && f.topics.includes('advance') && /(?:выплат|предостав|перечисл)[\s\S]{0,80}аванс|аванс[\s\S]{0,80}(?:выплач|предостав|перечисл)/iu.test(c.text)) n+=20;
  if (n && f.compareSources && /коммерческ\p{L}*\s+предложен/iu.test(c.documentTitle ?? '')) n+=10;
  if (n && f.topics.includes('retention')) {
    const facet=retentionFacet(c.text);
    if (facet) n+=facet.startsWith('rate:') ? 100 : 80;
  }
  return n;
};

export const rankAnswerCandidates = (candidates: readonly IPacketCandidate[], question: string): IPacketCandidate[] => {
  const focus=answerFocus(question);
  if (!focus.topics.length) return [...candidates];
  const scores=new Map(candidates.map(c=>[c.fragmentId,score(c,question)]));
  if(focus.topics.includes('award'))for(const group of answerContinuationGroups(candidates).values()){
    const best=Math.max(...group.map(id=>scores.get(id) ?? 0));if(best>0)for(const id of group)scores.set(id,Math.max(scores.get(id)??0,best-1));
  }
  const sorted=candidates.filter(c=>!focus.strict || scores.get(c.fragmentId)!>0).sort((a,b)=>scores.get(b.fragmentId)!-scores.get(a.fragmentId)!||a.rank-b.rank||a.fragmentId.localeCompare(b.fragmentId));
  // Один длинный документ не занимает весь пакет. Единица распознавания различает редакции и части,
  // даже когда им дали одинаковые названия; имя файла не служит идентификатором документа.
  const groups=new Map<string,IPacketCandidate[]>();
  for (const c of sorted) {
    const key=`${c.documentKey}:${c.sourceUnitId}:${c.sourcePart??''}`;
    const group=groups.get(key)??[];
    if (!group.some(g=>clean(g.text)===clean(c.text))) group.push(c);
    groups.set(key,group);
  }
  const all=[...groups.values()];
  if (focus.compareSources) {
    // Обе стороны сравнения получают место до вторых фрагментов одной стороны.
    all.sort((a,b)=>(sourceFamily(a[0]!.documentTitle,a[0]!.text)==='contract'?0:1)-(sourceFamily(b[0]!.documentTitle,b[0]!.text)==='contract'?0:1));
    const contracts=all.filter(g=>sourceFamily(g[0]!.documentTitle,g[0]!.text)==='contract');
    const others=all.filter(g=>sourceFamily(g[0]!.documentTitle,g[0]!.text)!=='contract');
    all.splice(0,all.length,...Array.from({length:Math.max(contracts.length,others.length)},(_,i)=>[contracts[i],others[i]]).flat().filter((g):g is IPacketCandidate[]=>Boolean(g)));
  }
  const result: IPacketCandidate[]=[];
  for (let round=0; all.some(g=>g[round]); round++) for (const group of all) if (group[round]) result.push(group[round]!);
  if(focus.history){
    const dates=questionDates(question);
    const dateOf=(c:IPacketCandidate)=>{const title=(c.documentTitle??'').replace(/(\d{4})[-_.](\d{2})[-_.](\d{2})/gu,'$3.$2.$1');return dates.find(d=>title.includes(d)) ?? '';};
    const tables=all.filter(g=>g[0]!.sourcePart && (!dates.length || dateOf(g[0]!)));
    const first=dates.length ? dates.flatMap(d=>{const g=tables.find(g=>dateOf(g[0]!)===d);return g?[g[0]!]:[];}).filter((c,i,a)=>a.findIndex(x=>x.fragmentId===c.fragmentId)===i) : tables.map(g=>g[0]!);
    const primary=[...first,...tables.map(g=>g[0]!)];const seen=new Set<string>();
    return [...primary,...result].filter(c=>{if(seen.has(c.fragmentId))return false;seen.add(c.fragmentId);return true;}).map((c,rank)=>({...c,rank}));
  }
  if (focus.compareSources && focus.topics.includes('retention')) {
    // Сначала разные роли условия, затем дополнительные редакции и копии. Иначе
    // десяток КП вытеснит второй процент и определения из одного и того же ДГП.
    const facets=new Set<string>();
    const primary=sorted.filter(c=>{
      const facet=retentionFacet(c.text);
      const family=sourceFamily(c.documentTitle,c.text);
      if (!facet || !['contract','proposal','terms'].includes(family)) return false;
      if (facet.startsWith('definition:') && !/определ|границ|вид\p{L}*\s+работ|МОП|квартир/iu.test(question)) return false;
      const key=`${family}:${facet}`;
      if (facets.has(key)) return false;
      facets.add(key);return true;
    });
    const used=new Set(primary.map(c=>c.fragmentId));
    return [...primary,...result.filter(c=>!used.has(c.fragmentId))].map((c,rank)=>({...c,rank}));
  }
  return result.map((c,rank)=>({...c,rank}));
};

export const answerExcerpt = (text: string, question: string, limit=1400): string => {
  if (text.length<=limit) return text;
  const focus=answerFocus(question);
  const preferred=focus.topics.includes('award') ? /победит|признать/iu : focus.history ? PRIMARY.price : focus.topics.includes('retention') ? /удержан|отделоч/iu : /аванс|банковск\p{L}*\s+гаранти/iu;
  const at=text.search(preferred);
  if (at<0) return text.slice(0,limit);
  let start=Math.max(0,at-160);
  const boundary=text.lastIndexOf('\n',at);
  if (boundary>=start) start=boundary+1;
  return text.slice(start,start+limit);
};

const clauses = (text: string): string[] => text.split(/\n+|[.!?](?:\s+|$)/u).map(clean).filter(Boolean);
const organizations = (text: string): string[] => [...text.matchAll(/(?:ООО|АО|ПАО|ЗАО|ОАО)\s*[«“"]([^»”"\n]+)[»”"]/giu)].map(m=>clean(m[1]!));
const literal = (claim: string, evidence: readonly IPacketItem[], every=false): boolean => {
  const contains=(e:IPacketItem)=>clean(e.text).includes(clean(claim).replace(/[.;]+$/u,''));
  return every ? evidence.every(contains) : evidence.some(contains);
};

export const groundingIssues = (claim: IDraftClaim, evidence: readonly IPacketItem[], question?: string, packet:readonly IPacketItem[]=evidence): { code:'source_type_mismatch'|'unsupported_relation'|'unsupported_absence'|'not_source_quote'|'off_topic'; detail:string }[] => {
  const issues: ReturnType<typeof groundingIssues>=[];
  if (!evidence.length) return issues;
  const text=claim.text;
  const awardClaim=/победител|итогов\p{L}*\s+стоимост\p{L}*\s+торг|дат\p{L}*\s+протокола/iu.test(text);
  if (awardClaim && !evidence.some(e=>sourceFamily(e.documentTitle,e.text)==='award')) issues.push({code:'source_type_mismatch',detail:'решение торгов требует протокола комитета, не акта оплаты/приёмки'});
  const topic=/удержан/iu.test(text)?/удержан/iu:/аванс/iu.test(text)?/аванс/iu:null;
  const relevant=topic ? evidence.flatMap(e=>clauses(e.text).filter(s=>topic.test(s))) : evidence.flatMap(e=>clauses(e.text));
  if (topic && !relevant.length) issues.push({code:'unsupported_relation',detail:'величина относится к другому условию'});
  const hasValues=/\d/u.test(text);
  const compatible=relevant.filter(s=>!hasValues || compareQuantities(text,[s]).every(q=>q.status==='ok'));
  if (/обязан|обязуется|должен/iu.test(text) && (!compatible.length || !compatible.some(s=>/обязан|обязуется|должен/iu.test(s)))) issues.push({code:'unsupported_relation',detail:'обязанность не подтверждена той же фразой и величиной'});
  if (topic && !/(?:^|\s)не\s/iu.test(text) && compatible.length && compatible.every(s=>/(?:^|\s)не\s+(?:выплач|предостав|предусмотр|перечисл)/iu.test(s))) issues.push({code:'unsupported_relation',detail:'отрицание в основании'});
  if (/победител/iu.test(text)) {
    const names=organizations(text);
    const decision=evidence.filter(e=>sourceFamily(e.documentTitle,e.text)==='award').flatMap(e=>clauses(e.text).filter(s=>/победител/iu.test(s)));
    if (!decision.length || names.some(n=>!decision.some(s=>s.includes(n)))) issues.push({code:'unsupported_relation',detail:'название победителя не связано с решением в протоколе'});
  }
  if (OFFER.test(text) && CONTRACT.test(text) && /одинаков|совпад|не\s+отлича/iu.test(text)) {
    if (!evidence.some(e=>sourceFamily(e.documentTitle,e.text)==='proposal') || !evidence.some(e=>sourceFamily(e.documentTitle,e.text)==='contract')) issues.push({code:'unsupported_relation',detail:'сравнение требует оснований обеих сторон'});
  }
  if (/не\s+(?:указан|предусмотрен|содерж|найден)|отсутству/iu.test(text) && !literal(text,evidence)) issues.push({code:'unsupported_absence',detail:'неполный пакет не доказывает отсутствие условия в документе'});
  if (question && answerFocus(question).strict && !literal(text,evidence,true)) issues.push({code:'not_source_quote',detail:'каждая ссылка сложного утверждения должна содержать ту же дословную цитату'});
  if (question) {
    const focus=answerFocus(question);
    if (focus.topics.includes('award') && !evidence.some(e=>sourceFamily(e.documentTitle,e.text)==='award')) issues.push({code:'source_type_mismatch',detail:'вопрос о решении торгов требует протокола комитета'});
    const related=focus.topics.some(t=>t==='retention' ? /удержан|отделоч/iu.test(text) : t==='advance' ? /аванс|банковск\p{L}*\s+гаранти/iu.test(text) : t==='price' ? PRIMARY.price.test(text) : /победит|признать|стоимост|цен|инженер|вознагражден|протокол/iu.test(text));
    if (focus.strict && focus.topics.length && !related && !(focus.topics.includes('award') && evidence.some(e=>answerContinuationGroups(packet).has(e.fragmentId)))) issues.push({code:'off_topic',detail:'утверждение не отвечает предмету вопроса'});
  }
  return issues;
};
