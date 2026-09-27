// Preview-only expression evaluation. No eval, getters, prototype access or game function calls.
setup.textValues = {
	get: function(object,key) {
		if (object == null || !['string','number'].includes(typeof key) || /^(constructor|prototype|__proto__)$/.test(String(key))) return undefined;
		var property=Object.getOwnPropertyDescriptor(Object(object),key);
		return property && Object.prototype.hasOwnProperty.call(property,'value') && typeof property.value !== 'function' ? property.value : undefined;
	},
	evaluate: function(plan, roots, depth) {
		var self=this; depth=depth||0;
		if (!plan || depth>40) return undefined;
		function read(p) { return self.evaluate(p,roots,depth+1); }
		function primitive(v) { return v===null || ['string','number','boolean','undefined'].includes(typeof v); }
		var a,b,args,name;
		switch(plan[0]) {
		case 'literal': return plan[1];
		case 'name':
			name=plan[1];
			if(name[0]==='$') return this.get(roots.variables,name.slice(1));
			if(name[0]==='_') return this.get(roots.temporary,name.slice(1));
			if(name==='State') return {variables:roots.variables,temporary:roots.temporary};
			if(name==='setup') return roots.setup;
			return this.get(roots.variables,name);
		case 'get': return this.get(read(plan[1]),read(plan[2]));
		case 'choice': return read(plan[1]) ? read(plan[2]) : read(plan[3]);
		case 'unary':
			a=read(plan[2]); if(!primitive(a)) return undefined;
			return plan[1]==='!' ? !a : plan[1]==='-' ? -a : plan[1]==='+' ? +a : undefined;
		case 'binary':
			a=read(plan[2]);
			if(plan[1]==='&&') return a && read(plan[3]);
			if(plan[1]==='||') return a || read(plan[3]);
			if(plan[1]==='??') return a==null ? read(plan[3]) : a;
			b=read(plan[3]); if(!primitive(a)||!primitive(b)) return undefined;
			switch(plan[1]) {
			case '+':return a+b; case '-':return a-b; case '*':return a*b; case '/':return b===0?undefined:a/b; case '%':return b===0?undefined:a%b;
			case '===':return a===b; case '!==':return a!==b; case '==':return a==b; case '!=':return a!=b;
			case '<':return a<b;case '>':return a>b;case '<=':return a<=b;case '>=':return a>=b;
			} return undefined;
		case 'call':
			name=plan[1]; args=plan[2].slice(0,16).map(read);
			if(/^Math\.(round|floor|ceil|abs|min|max)$/.test(name) && args.every(function(v){return typeof v==='number'&&isFinite(v);})) return Math[name.slice(5)].apply(Math,args);
			if(/^setup\.stats\.(getValue|getMax|getPercent|getBand)$/.test(name) && typeof args[0]==='string') {
				var value=this.get(this.get(roots.variables,'player'),args[0]);
				value=typeof value==='number'&&isFinite(value)?Math.max(0,Math.min(100,Math.round(value))):0;
				if(name.endsWith('getMax')) return 100;
				if(!name.endsWith('getValue') && typeof args[1]==='number' && isFinite(args[1])) value=Math.max(0,Math.min(100,Math.round(args[1])));
				if(name.endsWith('getBand')) {
					var stats=this.get(this.get(roots.setup,'stats'),'LIST');
					if(!Array.isArray(stats)) return undefined;
					var stat;for(var i=0;i<Math.min(stats.length,100);i++) {var candidate=this.get(stats,i);if(this.get(candidate,'key')===args[0]){stat=candidate;break;}}
					return stat && this.get(this.get(stat,'bands'),Math.min(4,Math.floor((this.get(stat,'kind')==='burden'?value:100-value)/20)));
				}
				return value;
			} return undefined;
		case 'method':
			a=read(plan[1]); args=plan[3].slice(0,1).map(read);
			if(plan[2]==='toFixed'&&typeof a==='number'&&isFinite(a)&&(args[0]===undefined||typeof args[0]==='number')) return a.toFixed(Math.max(0,Math.min(20,args[0]||0)));
			if(typeof a==='string'&&plan[2]==='toUpperCase') return a.toUpperCase();
			if(typeof a==='string'&&plan[2]==='toLowerCase') return a.toLowerCase();
			return undefined;
		}
	},
	snapshot: function(value, depth, seen) {
		depth=depth||0; seen=seen||new Set();
		seen.count=(seen.count||0)+1;if(seen.count>500) return null;
		if(value==null) return null;
		if(typeof value==='number') return isFinite(value)?value:null;
		if(typeof value==='string'||typeof value==='boolean') return value;
		if(typeof value!=='object'||depth>5||seen.has(value)) return null;
		seen.add(value);
		var result=Array.isArray(value)?[]:Object.create(null), self=this;
		Object.keys(value).slice(0,100).forEach(function(key){
			if(!/^(constructor|prototype|__proto__)$/.test(key)) result[key]=self.snapshot(self.get(value,key),depth+1,seen);
		});
		seen.delete(value);return result;
	},
	text: function(value) { return typeof value==='string'?value:JSON.stringify(value==null?null:value); },
	memory: function(slot) {
		if(Object.prototype.hasOwnProperty.call(slot,'literal')) return slot.literal;
		var plans=setup.textExpressionPlans||{}, plan=slot.plan;
		if(plan===undefined && Object.prototype.hasOwnProperty.call(plans,slot.expression)) plan=plans[slot.expression];
		if(plan===undefined && /^[A-Za-z_$][\w$]*$/.test(slot.expression||'')) plan=['name',slot.expression];
		var state=typeof State==='undefined'?{}:State;
		return this.snapshot(this.evaluate(plan,{variables:state.variables||{},temporary:state.temporary||{},setup:setup}));
	},
	value: function(slot, mode, override) {
		mode=override&&override.mode||mode;
		if(mode==='custom') return override.value;
		if(mode==='memory') return slot.memory;
		if(mode==='zero') return slot.kind==='STAT'||typeof slot.memory==='number'?0:null;
		return '['+slot.kind+']';
	},
	control: function(slot, context, index) {
		var self=this, key=String(index), wrapper=document.createElement('span'); wrapper.dataset.previewValue=key;
		var select=document.createElement('select');select.style.maxWidth='12em';select.style.width='auto';
		select.setAttribute('aria-label','[NEEDS WRITING PASS] '+slot.kind+' '+(index+1));
		var choices=[['inherit',''],['zero','0 / null'],['memory','Current values'],['tokens','['+slot.kind+']'],['custom','[NEEDS WRITING PASS] Manual value']];
		choices.forEach(function(pair){var o=document.createElement('option');o.value=pair[0];o.textContent=pair[1];select.appendChild(o);});
		var input=document.createElement('input');input.type='text';input.maxLength=2000;input.style.maxWidth='12em';
		input.setAttribute('aria-label','[NEEDS WRITING PASS] Manual '+slot.kind+' '+(index+1));
		function update() {
			var override=context.overrides[key], mode=override?override.mode:'inherit';
			choices.forEach(function(pair,i){select.options[i].textContent=pair[1];});
			select.options[0].textContent=(mode==='inherit'?'':'[NEEDS WRITING PASS] Use default: ')+self.text(self.value(slot,context.mode,null)).slice(0,80);
			select.value=mode;
			if(mode!=='inherit') select.selectedOptions[0].textContent=self.text(self.value(slot,context.mode,override)).slice(0,80);
			input.hidden=mode!=='custom';
			if(document.activeElement!==input) input.value=self.text(self.value(slot,context.mode,override));
			if(context.changed) context.changed();
		}
		select.addEventListener('change',function(){
			if(select.value==='inherit') delete context.overrides[key];
			else context.overrides[key]={mode:select.value,value:self.value(slot,context.mode,context.overrides[key])};
			update();if(select.value==='custom') input.focus();
		});
		input.addEventListener('input',function(){
			var value=input.value;try{value=JSON.parse(value);}catch(_){}
			context.overrides[key]={mode:'custom',value:value};update();
		});
		wrapper.appendChild(select);wrapper.appendChild(input);update();return wrapper;
	}
};
