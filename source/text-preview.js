// Deliberately not a Wikifier: previews may format writing, never execute story code.
setup.textPreview = {
	escape: function(text) {
		return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	},
	markup: function(source) {
		var self = this, missing = '[PLACEHOLDER]', hidden = 0;
		function literal(args) {
			var match = /^\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1/.exec(args);
			return match ? match[2].replace(/\\([\\"'])/g, '$1') : missing;
		}
		var text = String(source).replace(/\/%[\s\S]*?%\/|<!--([\s\S]*?)-->/g, '')
			.replace(/<<script\b[^>]*>>[\s\S]*?<<\/script\s*>>/gi, '');
		// Quoted arguments can themselves contain >>. Do not leak the remainder as code.
		var tokens = /<<((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^>"'`]|>(?!>))*)>>/g;
		function macro(body) {
			var token = /^\s*(\/?[\w-]+|=|-)\s*([\s\S]*)$/.exec(body);
			if (!token) return '';
			var name = token[1].toLowerCase(), args = token[2];
			if (/^(silently|widget)$/.test(name)) { hidden++; return ''; }
			if (/^\/(silently|widget)$/.test(name)) { hidden = Math.max(0,hidden-1); return ''; }
			if (hidden) return '';
			if (/^(link|linkreplace|linkappend|timedlink|button)$/.test(name)) return '<a>' + self.escape(literal(args));
			if (/^\/(link|linkreplace|linkappend|timedlink|button)$/.test(name)) return '</a>';
			if (/^(print|=|-)$/.test(name)) return self.escape(literal(args));
			if (name === 'uisection') {
				var rest = args.replace(/^\s*(["'])(?:\\.|(?!\1)[\s\S])*?\1\s*/, '');
				return '<div><strong>' + self.escape(literal(rest)) + '</strong><br>';
			}
			if (name === '/uisection') return '</div>';
			if (/^(else|elseif|case|default)$/.test(name)) return '<br>';
			if (/^(set|run|goto|if|for|switch|break|continue|capture|include|nobr|stop|return|startnewgame|init\w*)$/.test(name) || name[0] === '/') return '';
			return missing;
		}
		var output = '', cursor = 0, match;
		while ((match = tokens.exec(text))) {
			if (!hidden) output += text.slice(cursor,match.index);
			output += macro(match[1]); cursor = tokens.lastIndex;
		}
		text = output + (hidden ? '' : text.slice(cursor));
		text = text.replace(/\[\[([\s\S]*?)\]\]/g, function(_, link) {
			link = link.split('][')[0];
			var label = link.split(/->|\|/)[0];
			if (link.indexOf('<-') >= 0) label = link.split('<-').pop();
			return '<a>' + self.escape(label) + '</a>';
		});
		return text.replace(/<<[\s\S]*$/, '').replace(/\{[^{}]*\}/g, missing)
			.replace(/\$[A-Za-z_]\w*(?:\.[A-Za-z_]\w*|\[[^\]]*\])*/g, missing)
			.replace(/''([^']+?)''/g, '<strong>$1</strong>')
			.replace(/(^|[^:])\/\/([^/\n]+)\/\//g, '$1<em>$2</em>')
			.replace(/__([^\n]+?)__/g, '<u>$1</u>')
			.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
	},
	render: function(source) {
		var template = document.createElement('template');
		template.innerHTML = this.markup(source);
		var result = document.createElement('div'); result.dataset.textPreview = '';
		result.style.overflowWrap = 'anywhere';
		var allowed = /^(P|DIV|SPAN|BR|HR|STRONG|EM|B|I|U|S|DEL|INS|SMALL|SUP|SUB|H[1-6]|UL|OL|LI|BLOCKQUOTE|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|A|BUTTON|LABEL)$/;
		function copy(node, parent) {
			if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.textContent)); return; }
			if (node.nodeType !== 1 || /^(SCRIPT|STYLE|IFRAME|OBJECT|EMBED|SVG|MATH|TEMPLATE|NOSCRIPT|TEXTAREA)$/.test(node.tagName)) return;
			var target = parent;
			if (allowed.test(node.tagName)) {
				target = document.createElement(node.tagName.toLowerCase()); parent.appendChild(target);
				if (node.classList.contains('small-description')) target.className = 'small-description';
				if (node.hasAttribute('title')) target.title = node.getAttribute('title');
				['color','background-color','font-weight','font-style','text-decoration'].forEach(function(property) {
					var value = node.style.getPropertyValue(property);
					if (value && !/url|expression|var\(/i.test(value)) target.style.setProperty(property,value);
				});
				if (node.tagName === 'A') { target.setAttribute('aria-disabled','true'); target.className = 'link-internal'; }
				if (node.tagName === 'BUTTON') { target.type = 'button'; target.disabled = true; }
			}
			Array.from(node.childNodes).forEach(function(child) { copy(child,target); });
		}
		Array.from(template.content.childNodes).forEach(function(node) { copy(node,result); });
		return result;
	}
};
