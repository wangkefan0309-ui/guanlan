export interface CalendarState { open:boolean; month:string;openingTop?:number }
export function validDay(day:string):boolean{return /^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;}
export function shiftDay(day:string,amount:number):string{return new Date(Date.parse(day)+amount*86400_000).toISOString().slice(0,10);}
export function dateTitle(day:string,today:string):string{
  return new Date(`${day}T12:00:00+08:00`).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'})+(day===today?' · 今天':'');
}
function node<K extends keyof HTMLElementTagNameMap>(tag:K,cls:string,text=''){const result=document.createElement(tag);result.className=cls;result.textContent=text;return result;}
function control(label:string,action:()=>void,key:string){const button=node('button','sw-calendar-button',label);button.type='button';button.dataset.focusKey=key;button.addEventListener('click',action);return button;}
export function positionCalendar(panel:HTMLElement,scroller:HTMLElement){
  const viewport=scroller.getBoundingClientRect(),nav=scroller.querySelector<HTMLElement>('.sw-nav'),bounds=nav?.getBoundingClientRect();
  const sticky=nav&&bounds&&getComputedStyle(nav).position==='sticky'&&bounds.width>=viewport.width*.75?bounds.height:0;
  const top=Math.max(8,viewport.top)+sticky+8,bottom=Math.min(window.innerHeight,viewport.bottom)-8;
  panel.style.maxHeight=`${Math.max(160,bottom-top)}px`;let rectangle=panel.getBoundingClientRect();if(rectangle.bottom>bottom)scroller.scrollTop+=rectangle.bottom-bottom;rectangle=panel.getBoundingClientRect();if(rectangle.top<top)scroller.scrollTop-=top-rectangle.top;
}

/** One shared calendar for publication dates and discovery batch dates. No reads or writes. */
export function dateCalendar(options:{date:string;today:string;min:string;label:string;counts:ReadonlyMap<string,number>;state:CalendarState;choose:(day:string)=>void}):HTMLElement{
  const {date,today,min,label,counts,state,choose}=options;
  const root=node('div','sw-calendar'),trigger=control(`▦ 日历 · ${date}` ,()=>{if(state.open){close();return;}state.open=true;panel.hidden=false;trigger.setAttribute('aria-expanded','true');state.month=date.slice(0,7);draw();const scroller=root.closest<HTMLElement>('.sw-root');if(scroller){state.openingTop=scroller.scrollTop;positionCalendar(panel,scroller);}focusDay(date);},`calendar:${label}`);
  trigger.classList.add('sw-calendar-trigger');trigger.setAttribute('aria-label',`${label}日历`);trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded',String(state.open));
  const panel=node('div','sw-calendar-panel');panel.hidden=!state.open;panel.setAttribute('role','dialog');panel.setAttribute('aria-label',`${label}月历`);root.append(trigger,panel);
  function close(){state.open=false;panel.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.focus({preventScroll:true});const scroller=root.closest<HTMLElement>('.sw-root');if(scroller&&state.openingTop!==undefined)scroller.scrollTop=state.openingTop;delete state.openingTop;}
  const select=(day:string)=>{if(!validDay(day)||day<min||day>today)return;state.open=false;delete state.openingTop;choose(day);};
  function focusDay(day:string){const cell=panel.querySelector<HTMLButtonElement>(`[data-calendar-day="${day}"]`);cell?.focus({preventScroll:true});if(cell){const bounds=cell.getBoundingClientRect(),view=panel.getBoundingClientRect();if(bounds.bottom>view.bottom-8)panel.scrollTop+=bounds.bottom-view.bottom+8;if(bounds.top<view.top+8)panel.scrollTop-=view.top+8-bounds.top;}}
  function focusMonth(label:string){const target=panel.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`),fallback=panel.querySelector<HTMLButtonElement>('.sw-calendar-heading button:not(:disabled)')??panel.querySelector<HTMLElement>('.sw-calendar-heading strong');(target&&!target.disabled?target:fallback)?.focus({preventScroll:true});}
  function draw(){
    const content=document.createDocumentFragment();const month=state.month||date.slice(0,7),first=month+'-01';
    const heading=node('div','sw-calendar-heading'),previous=shiftDay(first,-1).slice(0,7),next=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,7);
    const back=control('‹',()=>{state.month=previous;draw();focusMonth('上个月');},'calendar:previous');back.setAttribute('aria-label','上个月');back.disabled=previous<min.slice(0,7);
    const forward=control('›',()=>{state.month=next;draw();focusMonth('下个月');},'calendar:next');forward.setAttribute('aria-label','下个月');forward.disabled=next>today.slice(0,7);
    const monthTitle=node('strong','',`${Number(month.slice(0,4))} 年 ${Number(month.slice(5,7))} 月`);monthTitle.tabIndex=-1;monthTitle.dataset.focusKey='calendar:month';heading.append(back,monthTitle,forward);content.append(heading);
    const weekdays=node('div','sw-calendar-weekdays');for(const day of['一','二','三','四','五','六','日'])weekdays.append(node('span','',day));content.append(weekdays);
    const grid=node('div','sw-calendar-grid');grid.setAttribute('aria-label','选择日期');const offset=(new Date(first).getUTCDay()+6)%7,start=shiftDay(first,-offset);
    for(let i=0;i<42;i++){
      const day=shiftDay(start,i),count=counts.get(day)??0,cell=control('',()=>select(day),`day:${day}`);cell.dataset.calendarDay=day;cell.setAttribute('aria-label',`${day}，${count}项${day===today?'，今天':''}`);cell.setAttribute('aria-pressed',String(day===date));cell.disabled=day<min||day>today;
      cell.classList.add('sw-calendar-day');if(!day.startsWith(month))cell.classList.add('is-outside');if(day===today)cell.classList.add('is-today');if(day===date)cell.classList.add('is-selected');
      cell.append(node('span','',String(Number(day.slice(8)))),node('small','sw-calendar-count',count?String(count):''));grid.append(cell);
      cell.addEventListener('keydown',event=>{const step=({ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}as Record<string,number>)[event.key];if(step===undefined)return;event.preventDefault();const target=shiftDay(day,step);if(target<min||target>today)return;if(!target.startsWith(state.month)){state.month=target.slice(0,7);draw();}focusDay(target);});
    }
    content.append(grid,node('p','sw-calendar-legend','数字为当天已保存内容数，空白日期也可查看。'));
    const jump=node('input','sw-input');jump.type='date';jump.value=date;jump.min=min;jump.max=today;jump.setAttribute('aria-label',label);jump.dataset.focusKey=`calendar-input:${label}`;jump.addEventListener('change',()=>select(jump.value));content.append(jump);
    const actions=node('div','sw-calendar-actions');actions.append(control('回到今天',()=>select(today),'calendar:today'),control('关闭日历',close,'calendar:close'));content.append(actions);panel.replaceChildren(content);panel.scrollTop=0;
  }
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
  root.addEventListener('focusout',event=>{if(event.relatedTarget&&!root.contains(event.relatedTarget as Node)){state.open=false;panel.hidden=true;trigger.setAttribute('aria-expanded','false');}});
  if(!state.month)state.month=date.slice(0,7);draw();return root;
}
