import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { orgSplit, WORLD_SEED } from './lib/catalog.mjs';
import { validateWorld } from './lib/gates.mjs';
import { annotationCard, buildPairs } from './lib/pairs.mjs';
import { agentCapabilityProfile, ubuddyCapabilityProfile } from './lib/profiles.mjs';
import { makeRng } from './lib/rng.mjs';
import { buildRoster } from './lib/world.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

export function generateWorld({ smoke = false, seed = WORLD_SEED } = {}) {
  const rng = makeRng(seed);
  const roster = buildRoster({ smoke, rng });
  const agentProfiles = roster.people.flatMap((person) => {
    const mine = roster.agents.filter((agent) => agent.ownerUserId === person.id);
    return mine.map((agent) => agentCapabilityProfile(agent, person));
  });
  const ubuddyProfiles = roster.people.map((person) => {
    const mine = roster.agents.filter((agent) => agent.ownerUserId === person.id);
    return ubuddyCapabilityProfile(person, mine);
  });
  const byId = new Map(roster.agents.map((agent) => [agent.id, agent]));
  const pairs = buildPairs({
    agents: roster.agents,
    profiles: agentProfiles,
    rng,
    smoke,
  }).map((pair) => {
    const left = byId.get(pair.leftAgentId);
    const right = byId.get(pair.rightAgentId);
    const splitLeft = orgSplit(left.orgId);
    const splitRight = orgSplit(right.orgId);
    const split = splitLeft === 'test' || splitRight === 'test'
      ? 'test'
      : splitLeft === 'development' || splitRight === 'development'
        ? 'development'
        : 'train';
    return { ...pair, split };
  });
  const cards = pairs.map((pair) => annotationCard(pair, byId.get(pair.leftAgentId), byId.get(pair.rightAgentId)));
  const world = {
    schema: 'cpdb_org_world_v1',
    seed,
    smoke,
    generatedAt: roster.generatedAt,
    orgs: roster.orgs,
    people: roster.people,
    agents: roster.agents,
    agentProfiles,
    ubuddyProfiles,
    pairs,
    cards,
  };
  world.validation = validateWorld(world);
  world.manifest = manifestOf(world);
  return world;
}

export function writeWorld(world, { smoke = false } = {}) {
  const dir = join(ROOT, 'data', smoke ? 'smoke' : 'full');
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, 'manifest.json'), world.manifest);
  writeJson(join(dir, 'validation.json'), world.validation);
  writeJsonl(join(dir, 'orgs.jsonl'), world.orgs);
  writeJsonl(join(dir, 'people.jsonl'), world.people);
  writeJsonl(join(dir, 'agents.jsonl'), world.agents);
  writeJsonl(join(dir, 'agent_profiles.jsonl'), world.agentProfiles);
  writeJsonl(join(dir, 'ubuddy_profiles.jsonl'), world.ubuddyProfiles);
  writeJsonl(join(dir, 'pairs.jsonl'), world.pairs);
  writeJsonl(join(dir, 'annotation_cards.jsonl'), world.cards.map(publicCard));
  writeJson(join(dir, 'world.summary.json'), {
    schema: world.schema,
    seed: world.seed,
    generatedAt: world.generatedAt,
    counts: world.manifest.counts,
    pairKinds: world.manifest.pairKinds,
    splits: world.manifest.splits,
  });
  return dir;
}

function publicCard(card) {
  const copy = { ...card };
  delete copy.teacher;
  return copy;
}

function manifestOf(world) {
  const pairKinds = {};
  const splits = { train: 0, development: 0, test: 0 };
  let twinPairs = 0;
  for (const pair of world.pairs) {
    pairKinds[pair.kind] = (pairKinds[pair.kind] || 0) + 1;
    splits[pair.split] = (splits[pair.split] || 0) + 1;
    if (pair.isTwin) twinPairs += 1;
  }
  const families = {};
  for (const agent of world.agents) families[agent.familyId] = (families[agent.familyId] || 0) + 1;
  return {
    schema: world.schema,
    seed: world.seed,
    smoke: world.smoke,
    generatedAt: world.generatedAt,
    counts: {
      orgs: world.orgs.length,
      people: world.people.length,
      agents: world.agents.length,
      ubuddyProfiles: world.ubuddyProfiles.length,
      agentProfiles: world.agentProfiles.length,
      pairs: world.pairs.length,
      cards: world.cards.length,
    },
    families,
    pairKinds,
    twinPairs,
    splits,
    notes: [
      '依赖分与相似度分开保存，没有合成总分。',
      'uBuddy 初始画像由其手下 5 个 Agent 的 Skill / 标签聚合。',
      'pairs.jsonl 含 teacher 初始化分数；annotation_cards.jsonl 供人工改标。',
    ],
  };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

const smoke = process.argv.includes('--smoke');
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const world = generateWorld({ smoke });
  const dir = writeWorld(world, { smoke });
  if (!world.validation.ok) {
    console.error(JSON.stringify(world.validation, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ dir, ...world.manifest.counts, pairKinds: world.manifest.pairKinds, splits: world.manifest.splits }, null, 2));
}
