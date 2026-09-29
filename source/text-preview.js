// Deliberately not a Wikifier: previews may format writing, never execute story code.
setup.textPreview = {
	escape: function(text) {
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	},
	markup: function(source, slots, bindings) {
		var self = this, hidden = 0; bindings=bindings||[];
		function hole(expression,kind,literal,plan) {
			kind=kind||(/setup\.stats\.|\b(health|hunger|thirst|sanity|immunity|fatigue)\b/.test(expression)?'STAT':'VALUE');
			if(!slots) return '['+kind+']';
			var item={expression:expression,kind:kind};
			if(literal!==undefined) item.literal=literal;
			if(plan!==undefined) item.plan=plan;
			slots.push(item);return '\uE100'+(slots.length-1)+'\uE101';
		}
		function literal(args) {
			var match = /^\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/.exec(args);
			return match ? match[2].replace(/\\([\\"'])/g, '$1').replace(/\uE000(\d+)\uE001/g,function(_,index){
				return setup.textValues.text(setup.textValues.memory(bindings[index]||{}));
			}) : undefined;
		}
		// Comments and scripts are blanked to their line breaks rather than cut, so a link's line within the text stays
		// true: each link is marked with it (data-source-line), for the wiki to say where in the source it is.
		var blank = function(found) { return found.replace(/[^\n]/g, ''); };
		var text = String(source).replace(/\/%[\s\S]*?%\/|<!--([\s\S]*?)-->/g, blank)
			.replace(/<<script\b[^>]*>>[\s\S]*?<<\/script\s*>>/gi, blank);
		var lineAt = function(offset) { return text.slice(0, offset).split('\n').length - 1; };
		text = text.replace(/\[\[/g, function(found, offset) { return '[[\uE200' + lineAt(offset) + '\uE201'; });
		var macroLine = 0;
		// What a link runs: the macros and setup functions inside it, listed after it (data-uses) for the wiki to say
		// where each is defined.
		var linkUses = null;
		var uses = function(list) { return list.length ? '<span data-uses="' + self.escape(list.join(' ')) + '"></span>' : ''; };
		// Quoted arguments can themselves contain >>. Do not leak the remainder as code.
		var tokens = /<<((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^>"'`]|>(?!>))*)>>/g;
		function macro(body) {
			var token = /^\s*(\/?[\w-]+|=|-)\s*([\s\S]*)$/.exec(body);
			if (!token) return '';
			var name = token[1].toLowerCase(), args = token[2], original = token[1];
			if (linkUses && !/^\/(link|linkreplace|linkappend|timedlink|button)$/.test(name)) {
				linkUses.push('macro:' + original);
				(args.match(/setup\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g) || []).forEach(function(reference) { linkUses.push(reference); });
			}
			if (/^(silently|widget)$/.test(name)) { hidden++; return ''; }
			if (/^\/(silently|widget)$/.test(name)) { hidden = Math.max(0,hidden-1); return ''; }
			if (hidden) return '';
			if (/^(link|linkreplace|linkappend|timedlink|button)$/.test(name)) {
				linkUses = [];
				return '<a data-source-line="' + macroLine + '">' + hole(args,'LINK',literal(args));
			}
			if (/^\/(link|linkreplace|linkappend|timedlink|button)$/.test(name)) {
				var used = linkUses || [];
				linkUses = null;
				return '</a>' + uses(used);
			}
			if (/^(print|=|-)$/.test(name)) return hole(args,undefined,/^\s*(["'])(?:\\.|(?!\1)[\s\S])*\1\s*$/.test(args)?literal(args):undefined);
			if (name === 'uisection') {
				var rest = args.replace(/^\s*(["'])(?:\\.|(?!\1)[\s\S])*?\1\s*/, '');
				return '<div><strong>' + self.escape(literal(rest)||'[TEXT]') + '</strong><br>';
			}
			if (name === '/uisection') return '</div>';
			if (/^(else|elseif|case|default)$/.test(name)) return '<br>';
			if (/^(set|run|goto|if|for|switch|break|continue|capture|include|nobr|stop|return|startnewgame|init\w*)$/.test(name) || name[0] === '/') return '';
			if(name==='playerstats' && setup.stats) return setup.stats.LIST.map(function(stat){
				return '<div>'+self.escape(stat.label)+': '+hole('','STAT',undefined,['call','setup.stats.getValue',[['literal',stat.key]]])+'</div>';
			}).join('');
			return hole(name,'TEXT',undefined,null) + uses(['macro:' + original]);
		}
		var output = '', cursor = 0, match;
		while ((match = tokens.exec(text))) {
			if (!hidden) output += text.slice(cursor,match.index);
			macroLine = lineAt(match.index);
			output += macro(match[1]); cursor = tokens.lastIndex;
		}
		text = output + (hidden ? '' : text.slice(cursor));
		text = text.replace(/\[\[\uE200(\d+)\uE201([\s\S]*?)\]\]/g, function(_, line, link) {
			link = link.split('][')[0];
			var label = link.split(/->|\|/)[0];
			if (link.indexOf('<-') >= 0) label = link.split('<-').pop();
			return '<a data-source-line="' + line + '">' + hole('','LINK',label) + '</a>';
		}).replace(/\uE200\d+\uE201/g, '');
		return text.replace(/<<[\s\S]*$/, '').replace(/\uE000(\d+)\uE001/g,function(_,index){
			var binding=bindings[index]||{};return hole(binding.expression||'',binding.kind,undefined,binding.plan||null);
		}).replace(/\{([^{}]*)\}/g,function(_,expression){return hole(expression);})
			.replace(/\$[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]]*\])*/g,function(expression){return hole(expression);})
			.replace(/''([^']+?)''/g, '<strong>$1</strong>')
			.replace(/(^|[^:])\/\/([^/\n]+)\/\//g, '$1<em>$2</em>')
			.replace(/__([^\n]+?)__/g, '<u>$1</u>')
			.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
	},
	render: function(source, context) {
		context=context||{};
		context.mode=context.mode||'tokens';context.overrides=context.overrides||Object.create(null);
		var slots=[], values=setup.textValues;
		var template = document.createElement('template');
		template.innerHTML = this.markup(source,slots,context.bindings);
		slots.forEach(function(slot){slot.memory=values.memory(slot);});
		var result = document.createElement('div'); result.dataset.textPreview = '';
		result.style.overflowWrap = 'anywhere';
		var attributes=[];
		function resolved(text) {
			return text.replace(/\uE100(\d+)\uE101/g,function(_,index){
				return slots[index]?values.text(values.value(slots[index],context.mode,context.overrides[index])):'';
			});
		}
		context.changed=function(){attributes.forEach(function(item){item.element.title=resolved(item.text);});};
		function appendText(text,parent) {
			var cursor=0,pattern=/\uE100(\d+)\uE101/g,match;
			while((match=pattern.exec(text))) {
				parent.appendChild(document.createTextNode(text.slice(cursor,match.index)));
				var index=Number(match[1]),slot=slots[index];
				if(slot) parent.appendChild(context.interactive?values.control(slot,context,index):document.createTextNode(resolved(match[0])));
				cursor=pattern.lastIndex;
			}
			parent.appendChild(document.createTextNode(text.slice(cursor)));
		}
		var allowed = /^(P|DIV|SPAN|BR|HR|STRONG|EM|B|I|U|S|DEL|INS|SMALL|SUP|SUB|H[1-6]|UL|OL|LI|BLOCKQUOTE|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|A|BUTTON|LABEL)$/;
		// Where the macros and setup functions a link or a macro uses are defined (setup.textDefinitions, from the text
		// catalogue): a setup reference is matched by its longest defined prefix; anything not defined here is left out.
		function definedAt(names) {
			var definitions = setup.textDefinitions || {}, seen = {}, found = [];
			names.split(' ').forEach(function(name) {
				var key = name;
				while (key && !definitions[key] && key.indexOf('.') > 0) key = key.slice(0, key.lastIndexOf('.'));
				if (!key || !definitions[key] || seen[key] || key === 'setup') return;
				seen[key] = true;
				found.push((key.indexOf('macro:') === 0 ? '<<' + key.slice(6) + '>>' : key) + ' ' + definitions[key]);
			});
			return found;
		}
		function copy(node, parent) {
			if (node.nodeType === 3) { appendText(node.textContent,parent); return; }
			if (node.nodeType === 1 && node.hasAttribute('data-uses')) {
				var found = definedAt(node.getAttribute('data-uses'));
				if (found.length) {
					var list = document.createElement('small');
					list.className = 'text-preview-source';
					list.dataset.definitions = '';
					list.textContent = ' [' + found.join(', ') + ']';
					parent.appendChild(list);
				}
				return;
			}
			if (node.nodeType !== 1 || /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|TEMPLATE|NOSCRIPT|TEXTAREA)$/.test(node.tagName)) return;
			var target = parent;
			if (allowed.test(node.tagName)) {
				target = document.createElement(node.tagName.toLowerCase()); parent.appendChild(target);
				if (node.classList.contains('small-description')) target.className = 'small-description';
				if (node.hasAttribute('title')) {
					var title=node.getAttribute('title');attributes.push({element:target,text:title});target.title=resolved(title);
					if(context.interactive) {
						for(var match of title.matchAll(/\uE100(\d+)\uE101/g)) if(slots[match[1]]) parent.appendChild(values.control(slots[match[1]],context,Number(match[1])));
					}
				}
				['color','background-color','font-weight','font-style','text-decoration'].forEach(function(property) {
					var value = node.style.getPropertyValue(property);
					if (value && !/url|expression|var\(/i.test(value)) target.style.setProperty(property,value);
				});
				if (node.tagName === 'A') { target.dataset.previewLink=''; target.className = 'link-internal'; }
				if (node.tagName === 'BUTTON') { target.type = 'button'; target.disabled = true; }
			}
			Array.from(node.childNodes).forEach(function(child) { copy(child,target); });
			// Where the link is in the source: the entry's file, and its first line plus the link's line within it.
			if (node.tagName === 'A' && context.source && node.hasAttribute('data-source-line')) {
				var where = document.createElement('small');
				where.className = 'text-preview-source';
				where.dataset.sourceLocation = '';
				where.textContent = ' (' + String(context.source.file).split('/').pop() + ':'
					+ (Number(context.source.line) + Number(node.getAttribute('data-source-line'))) + ')';
				parent.appendChild(where);
			}
		}
		Array.from(template.content.childNodes).forEach(function(node) { copy(node,result); });
		return result;
	}
};
