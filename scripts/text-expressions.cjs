// Compile a deliberately small, read-only expression language. Never ship eval/Function to the wiki.
const acorn = require('acorn');
function name(node) {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) return name(node.object)+'.'+node.property.name;
  return '';
}
function encode(node) {
  if (!node) return null;
  switch (node.type) {
    case 'Literal': return ['string','number','boolean'].includes(typeof node.value) || node.value === null ? ['literal',node.value] : null;
    case 'Identifier': return ['name',node.name];
    case 'MemberExpression': return ['get',encode(node.object),node.computed?encode(node.property):['literal',node.property.name]];
    case 'UnaryExpression': return ['unary',node.operator,encode(node.argument)];
    case 'BinaryExpression': case 'LogicalExpression': return ['binary',node.operator,encode(node.left),encode(node.right)];
    case 'ConditionalExpression': return ['choice',encode(node.test),encode(node.consequent),encode(node.alternate)];
    case 'CallExpression': {
      const call=name(node.callee), args=node.arguments.map(encode);
      if (/^Math\.(round|floor|ceil|abs|min|max)$/.test(call) || /^setup\.stats\.(getValue|getMax|getPercent|getBand)$/.test(call)) return ['call',call,args];
      if (node.callee.type === 'MemberExpression' && !node.callee.computed && /^(toFixed|toUpperCase|toLowerCase)$/.test(node.callee.property.name)) {
        return ['method',encode(node.callee.object),node.callee.property.name,args];
      }
      return null;
    }
    default: return null;
  }
}
function parse(text) {
  try { return encode(acorn.parseExpressionAt(text.trim(),0,{ecmaVersion:'latest'})); } catch (_) { return null; }
}
function plansFor(entries) {
  const plans=Object.create(null);
  const add=expression=>{ expression=expression.trim(); if(expression) plans[expression]=parse(expression); };
  for (const row of entries) {
    const text=row[4];
    for (const match of text.matchAll(/<<((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^>"'`]|>(?!>))*)>>/g)) {
      const macro=/^\s*(print\b|=|-|link\b|linkreplace\b|linkappend\b|timedlink\b|button\b)\s*([\s\S]*)$/.exec(match[1]);
      if(macro) add(macro[2]);
    }
    for(const match of text.matchAll(/\$[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]]*\])*/g)) add(match[0]);
  }
  return plans;
}
module.exports={encode,parse,plansFor};
