import { readFileSync } from "node:fs";

const path = process.env.M151_SNAPSHOT_PATH;
if (!path) throw new Error("Set M151_SNAPSHOT_PATH to the temporary heap snapshot");
const snapshot = JSON.parse(readFileSync(path, "utf8"));
const { node_fields: nodeFields, node_types: nodeTypes, edge_fields: edgeFields, edge_types: edgeTypes } =
  snapshot.snapshot.meta;
const nodes = snapshot.nodes;
const edges = snapshot.edges;
const strings = snapshot.strings;
const nf = nodeFields.length;
const ef = edgeFields.length;
const nType = nodeFields.indexOf("type");
const nName = nodeFields.indexOf("name");
const nId = nodeFields.indexOf("id");
const nEdgeCount = nodeFields.indexOf("edge_count");
const eType = edgeFields.indexOf("type");
const eName = edgeFields.indexOf("name_or_index");
const eTo = edgeFields.indexOf("to_node");
const typeNames = nodeTypes[nType];
const edgeTypeNames = edgeTypes[eType];
const nodeCount = nodes.length / nf;
const edgeCount = edges.length / ef;
const incomingHead = new Int32Array(nodeCount).fill(-1);
const edgeSource = new Int32Array(edgeCount);
const edgeNext = new Int32Array(edgeCount);

function nodeName(index) { return strings[nodes[index * nf + nName]] ?? ""; }
function nodeType(index) { return typeNames[nodes[index * nf + nType]] ?? "?"; }
function edgeLabel(edgeIndex) {
  const kind = edgeTypeNames[edges[edgeIndex * ef + eType]] ?? "?";
  const raw = edges[edgeIndex * ef + eName];
  const label = kind === "element" ? String(raw) : strings[raw] ?? String(raw);
  return `${kind}:${label}`;
}

let edgeIndex = 0;
let sourceIndex = 0;
for (let nodeOffset = 0; nodeOffset < nodes.length; nodeOffset += nf) {
  const count = nodes[nodeOffset + nEdgeCount];
  for (let local = 0; local < count; local += 1, edgeIndex += 1) {
    const target = edges[edgeIndex * ef + eTo] / nf;
    edgeSource[edgeIndex] = sourceIndex;
    edgeNext[edgeIndex] = incomingHead[target];
    incomingHead[target] = edgeIndex;
  }
  sourceIndex += 1;
}

const hosts = [];
for (let node = 0, currentEdge = 0; node < nodeCount; node += 1) {
  const count = nodes[node * nf + nEdgeCount];
  for (let local = 0; local < count; local += 1, currentEdge += 1) {
    if (
      edgeTypeNames[edges[currentEdge * ef + eType]] === "property" &&
      strings[edges[currentEdge * ef + eName]] === "__m151RetentionProbe"
    ) hosts.push({ node, marker: nodeName(edges[currentEdge * ef + eTo] / nf), id: nodes[node * nf + nId] });
  }
}

function findRetainerPath(start) {
  const parent = new Int32Array(nodeCount).fill(-1);
  const viaEdge = new Int32Array(nodeCount).fill(-1);
  const queue = new Int32Array(nodeCount);
  let read = 0;
  let write = 0;
  queue[write++] = start;
  parent[start] = start;
  let root = -1;
  while (read < write) {
    const current = queue[read++];
    if (nodeType(current) === "synthetic" && /GC roots/.test(nodeName(current))) {
      root = current;
      break;
    }
    for (let incoming = incomingHead[current]; incoming !== -1; incoming = edgeNext[incoming]) {
      if (edgeTypeNames[edges[incoming * ef + eType]] === "weak") continue;
      const from = edgeSource[incoming];
      if (parent[from] !== -1) continue;
      parent[from] = current;
      viaEdge[from] = incoming;
      queue[write++] = from;
    }
  }
  if (root === -1) return { rootFound: false };
  const chain = [];
  let current = root;
  while (current !== start) {
    const target = parent[current];
    chain.push({
      retainer: `${nodeType(current)} ${nodeName(current).slice(0, 100)}`,
      edge: edgeLabel(viaEdge[current]),
      target: `${nodeType(target)} ${nodeName(target).slice(0, 100)}`,
    });
    current = target;
  }
  return { rootFound: true, pathFromRoot: chain };
}

console.log(JSON.stringify({
  nodeCount,
  edgeCount,
  markedHosts: hosts.map(({ node, marker, id }) => ({ marker, nodeId: id, ...findRetainerPath(node) })),
}, null, 2));
