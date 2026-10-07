import React,{createContext,useContext} from 'react';
import {formatDashboardDateTime,normalizeTimeFormat} from './timeDisplay.mjs';

const TimeFormatContext=createContext('24h');

export function TimeFormatProvider({value,children}){
  return <TimeFormatContext.Provider value={normalizeTimeFormat(value)}>{children}</TimeFormatContext.Provider>;
}

export function useTimeFormat(){return useContext(TimeFormatContext);}

export function useDateTimeFormatter(){
  const timeFormat=useTimeFormat();
  return (value,options={})=>formatDashboardDateTime(value,{...options,timeFormat});
}
