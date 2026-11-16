interface FocusState {key?:string;label?:string;item?:string;disclosure?:string;start:number|null;end:number|null}
/** Capture scroll before replacing nodes; Obsidian's own styles can force intermediate layout. */
export function capturePosition(root:HTMLElement){
  const libraryRoot=root.dataset.libraryRoot;
  const scroll:{node:HTMLElement;top:number;left:number}[]=[];for(let node:HTMLElement|null=root;node;node=node.parentElement)scroll.push({node,top:node.scrollTop,left:node.scrollLeft});
  const active=root.contains(document.activeElement)?document.activeElement as HTMLInputElement:null;
  const focus:FocusState|undefined=active?{key:active.dataset.focusKey,label:active.getAttribute('aria-label')??undefined,item:active.closest<HTMLElement>('[data-item-key]')?.dataset.itemKey,disclosure:active.closest<HTMLDetailsElement>('details[data-disclosure]')?.dataset.disclosure,start:active.selectionStart??null,end:active.selectionEnd??null}:undefined;
  return ()=>{
    if(focus&&libraryRoot===root.dataset.libraryRoot){const candidates=[...root.querySelectorAll<HTMLElement>('[data-focus-key],[aria-label],details[data-disclosure]>summary')];const next=candidates.find(node=>(focus.key?node.dataset.focusKey===focus.key:focus.label?node.getAttribute('aria-label')===focus.label:focus.disclosure?node.closest<HTMLDetailsElement>('details')?.dataset.disclosure===focus.disclosure:false)&&(!focus.item||node.closest<HTMLElement>('[data-item-key]')?.dataset.itemKey===focus.item));
      next?.focus({preventScroll:true});if(next instanceof HTMLInputElement&&focus.start!==null){try{next.setSelectionRange(focus.start,focus.end??focus.start);}catch{}}
    }
    for(const entry of scroll){entry.node.scrollTop=entry.top;entry.node.scrollLeft=entry.left;}
  };
}
