/* global clearTimeout, document, setTimeout, window */
import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {
  addCalendarDays,addCalendarMonths,calendarDayBefore,calendarMonthDays,
  clampLocalDateTime,combineLocalDateAndTime,localDateTimeValue,parseLocalDateTime,
  pickerDisplayValue,sameCalendarDay,startOfCalendarMonth,
} from './dateTimePicker.mjs';
import './dateTimePicker.css';

const CALENDAR_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/>
  <path d="M8 3v4M16 3v4M3 10h18"/></svg>;
const PREVIOUS_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>;
const NEXT_ICON=<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>;
const WEEKDAYS=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function pad(value){return String(value).padStart(2,'0');}
function timeParts(date){return {hour:pad(date.getHours()),minute:pad(date.getMinutes()),second:pad(date.getSeconds())};}
function dayLabel(date){return new Intl.DateTimeFormat(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'}).format(date);}
function monthLabel(date){return new Intl.DateTimeFormat(undefined,{month:'long',year:'numeric'}).format(date);}
function firstUsableValue(value,min){
  const parsed=parseLocalDateTime(value);
  const minimum=parseLocalDateTime(min);
  if(parsed)return clampLocalDateTime(parsed,minimum);
  if(minimum)return new Date(minimum.getTime());
  const now=new Date();now.setMilliseconds(0);return now;
}
function normalizeTimePart(value,max){
  const number=Number(value);
  if(!Number.isInteger(number))return '';
  return pad(Math.max(0,Math.min(max,number)));
}
/**
 * A controlled, dependency-free local date/time picker. `value`, `min`, and emitted values all use
 * the same second-precision local-wall-clock shape used by the former browser date field:
 * YYYY-MM-DDTHH:mm:ss. It does
 * not apply a timezone conversion; callers retain ownership of converting the chosen local wall
 * clock to UTC when they submit it.
 */
export default function DateTimePicker({name,label,value='',min='',onChange,disabled=false,required=false,
  active=true,className='',placeholder='Choose date and time',autoFocus=false,
  'aria-describedby':describedBy}){
  const uid=useId().replace(/:/g,'');
  const labelId=`date-time-label-${uid}`;
  const dialogId=`date-time-dialog-${uid}`;
  const monthId=`date-time-month-${uid}`;
  const triggerRef=useRef(null);
  const dialogRef=useRef(null);
  const dayRefs=useRef(new Map());
  const focusDateAfterRender=useRef(false);
  const [open,setOpen]=useState(false);
  const [selectedDate,setSelectedDate]=useState(()=>firstUsableValue(value,min));
  const [viewMonth,setViewMonth]=useState(()=>startOfCalendarMonth(firstUsableValue(value,min)));
  const [activeDate,setActiveDate]=useState(()=>firstUsableValue(value,min));
  const [time,setTime]=useState(()=>timeParts(firstUsableValue(value,min)));
  const minimum=useMemo(()=>parseLocalDateTime(min),[min]);
  const days=useMemo(()=>calendarMonthDays(viewMonth),[viewMonth]);
  const weeks=useMemo(()=>Array.from({length:6},(_,index)=>days.slice(index*7,index*7+7)),[days]);
  const combined=combineLocalDateAndTime(selectedDate,time);
  const valid=Boolean(combined&&(!minimum||combined.getTime()>=minimum.getTime()));
  const display=pickerDisplayValue(value);

  function resetDraft(){
    const seed=firstUsableValue(value,min);
    setSelectedDate(seed);setActiveDate(seed);setViewMonth(startOfCalendarMonth(seed));setTime(timeParts(seed));
  }
  function openPicker(){if(disabled)return;resetDraft();setOpen(true);}
  function closePicker({restoreFocus=true}={}){setOpen(false);if(restoreFocus)setTimeout(()=>triggerRef.current?.focus(),0);}
  function cancel(){resetDraft();closePicker();}
  function apply(){
    if(!valid)return;
    const next=localDateTimeValue(combined);
    if(next!==value)onChange?.({target:{name,value:next},currentTarget:{name,value:next}});
    closePicker();
  }
  function selectDate(date){
    if(minimum&&calendarDayBefore(date,minimum))return;
    let nextTime=time;
    const next=combineLocalDateAndTime(date,time);
    if(minimum&&next&&next.getTime()<minimum.getTime())nextTime=timeParts(minimum);
    setSelectedDate(date);setActiveDate(date);setViewMonth(startOfCalendarMonth(date));setTime(nextTime);
  }
  function focusDate(date){
    if(!date)return;
    setActiveDate(date);setViewMonth(startOfCalendarMonth(date));focusDateAfterRender.current=true;
  }
  function onDayKeyDown(event,date){
    let next=null;
    if(event.key==='ArrowLeft')next=addCalendarDays(date,-1);
    else if(event.key==='ArrowRight')next=addCalendarDays(date,1);
    else if(event.key==='ArrowUp')next=addCalendarDays(date,-7);
    else if(event.key==='ArrowDown')next=addCalendarDays(date,7);
    else if(event.key==='Home')next=addCalendarDays(date,-date.getDay());
    else if(event.key==='End')next=addCalendarDays(date,6-date.getDay());
    else if(event.key==='PageUp')next=addCalendarMonths(date,event.shiftKey?-12:-1);
    else if(event.key==='PageDown')next=addCalendarMonths(date,event.shiftKey?12:1);
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();selectDate(date);return;}
    if(!next)return;
    event.preventDefault();
    if(minimum&&calendarDayBefore(next,minimum))next=new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate());
    focusDate(next);
  }
  function changeTime(part,max,event){
    const digits=event.target.value.replace(/\D/g,'').slice(0,2);
    setTime(current=>({...current,[part]:digits&&Number(digits)>max?String(max):digits}));
  }
  function finishTime(part,max){setTime(current=>({...current,[part]:normalizeTimePart(current[part],max)}));}
  function changeMonth(amount){
    const next=addCalendarMonths(viewMonth,amount);
    if(!next)return;
    const candidate=new Date(next.getFullYear(),next.getMonth(),Math.min(activeDate.getDate(),
      new Date(next.getFullYear(),next.getMonth()+1,0).getDate()));
    if(minimum&&calendarDayBefore(candidate,minimum))focusDate(new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate()));
    else focusDate(candidate);
  }
  function trapFocus(event){
    if(event.key!=='Tab')return;
    const controls=[...dialogRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
      .filter(control=>control.offsetParent!==null);
    if(!controls.length)return;
    const first=controls[0],last=controls[controls.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  }

  useEffect(()=>{
    if(!open)return undefined;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const onKeyDown=event=>{if(event.key==='Escape'){event.preventDefault();cancel();}};
    const onPointerDown=event=>{if(dialogRef.current&&!dialogRef.current.contains(event.target)&&event.target!==triggerRef.current)cancel();};
    document.addEventListener('keydown',onKeyDown);
    document.addEventListener('mousedown',onPointerDown);
    setTimeout(()=>dayRefs.current.get(localDateTimeValue(activeDate).slice(0,10))?.focus(),0);
    return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',onKeyDown);document.removeEventListener('mousedown',onPointerDown);};
  },[open]);
  useEffect(()=>{
    if(!open||!focusDateAfterRender.current)return;
    focusDateAfterRender.current=false;
    dayRefs.current.get(localDateTimeValue(activeDate).slice(0,10))?.focus();
  },[open,activeDate,viewMonth]);
  // Mint tabs remain mounted so in-progress reads survive navigation. Close this modal when its
  // tab becomes inactive; otherwise an invisible picker would retain the body scroll lock.
  useEffect(()=>{if(!active&&open)setOpen(false);},[active,open]);

  const previousMonth=addCalendarMonths(viewMonth,-1);
  const previousMonthDisabled=Boolean(minimum&&previousMonth
    && new Date(previousMonth.getFullYear(),previousMonth.getMonth()+1,0)<new Date(minimum.getFullYear(),minimum.getMonth(),minimum.getDate()));
  const today=new Date();
  return <div className={`date-time-picker ${className}`.trim()}>
    <span className="date-time-picker-label" id={labelId}>{label}</span>
    {name&&<input type="hidden" name={name} value={value} disabled={disabled}/>}
    <button type="button" className="date-time-picker-trigger" ref={triggerRef} disabled={disabled} autoFocus={autoFocus}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} aria-labelledby={`${labelId} ${labelId}-value`}
      aria-describedby={describedBy} aria-required={required||undefined} onClick={()=>open?cancel():openPicker()}>
      <span className="date-time-picker-icon">{CALENDAR_ICON}</span>
      <span className={`date-time-picker-value${display?'':' placeholder'}`} id={`${labelId}-value`}>{display||placeholder}</span>
    </button>
    {open&&<>
      <div className="date-time-picker-backdrop" aria-hidden="true"/>
      <div className="date-time-picker-dialog" id={dialogId} role="dialog" aria-modal="true"
        aria-labelledby={monthId} ref={dialogRef} onKeyDown={trapFocus}>
        <div className="date-time-picker-header">
          <div><span>Choose date and time</span><b id={monthId}>{monthLabel(viewMonth)}</b></div>
          <div className="date-time-picker-month-actions">
            <button type="button" disabled={previousMonthDisabled} aria-label="Previous month" onClick={()=>changeMonth(-1)}>{PREVIOUS_ICON}</button>
            <button type="button" aria-label="Next month" onClick={()=>changeMonth(1)}>{NEXT_ICON}</button>
          </div>
        </div>
        <div className="date-time-picker-weekdays" role="row">{WEEKDAYS.map(day=><span role="columnheader" aria-label={day} key={day}>{day}</span>)}</div>
        <div className="date-time-picker-grid" role="grid" aria-labelledby={monthId}>
          {weeks.map((week,weekIndex)=><div className="date-time-picker-grid-row" role="row" key={weekIndex}>{week.map(date=>{
            const key=localDateTimeValue(date).slice(0,10);
            const outside=date.getMonth()!==viewMonth.getMonth();
            const blocked=Boolean(minimum&&calendarDayBefore(date,minimum));
            const selected=sameCalendarDay(date,selectedDate);
            const active=sameCalendarDay(date,activeDate);
            return <button type="button" role="gridcell" key={key} ref={node=>{if(node)dayRefs.current.set(key,node);else dayRefs.current.delete(key);}}
              className={`${outside?' outside':''}${selected?' selected':''}${sameCalendarDay(date,today)?' today':''}`}
              tabIndex={active?0:-1} disabled={blocked} aria-selected={selected} aria-current={sameCalendarDay(date,today)?'date':undefined}
              aria-label={dayLabel(date)} onClick={()=>selectDate(date)} onKeyDown={event=>onDayKeyDown(event,date)}>{date.getDate()}</button>;
          })}</div>)}
        </div>
        <fieldset className="date-time-picker-time">
          <legend>Local time</legend>
          <label><span>Hour</span><input type="text" inputMode="numeric" maxLength="2" value={time.hour}
            aria-label="Hour, 00 to 23" onChange={event=>changeTime('hour',23,event)} onBlur={()=>finishTime('hour',23)}/></label>
          <span aria-hidden="true">:</span>
          <label><span>Minute</span><input type="text" inputMode="numeric" maxLength="2" value={time.minute}
            aria-label="Minute, 00 to 59" onChange={event=>changeTime('minute',59,event)} onBlur={()=>finishTime('minute',59)}/></label>
          <span aria-hidden="true">:</span>
          <label><span>Second</span><input type="text" inputMode="numeric" maxLength="2" value={time.second}
            aria-label="Second, 00 to 59" onChange={event=>changeTime('second',59,event)} onBlur={()=>finishTime('second',59)}/></label>
        </fieldset>
        {!valid&&<p className="date-time-picker-error" role="alert">Choose a valid time{minimum?` on or after ${pickerDisplayValue(min)}`:''}.</p>}
        <div className="date-time-picker-footer">
          <button type="button" className="b g" onClick={cancel}>Cancel</button>
          <button type="button" className="b p" disabled={!valid} onClick={apply}>Apply</button>
        </div>
      </div>
    </>}
  </div>;
}
