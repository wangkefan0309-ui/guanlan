import {describe,it,expect} from 'vitest';
import {dateTitle,shiftDay,validDay} from '../src/ui/date-calendar';
describe('日历日期边界',()=>{
  it('只接受实际存在的完整日期，不把溢出日期当另一个月',()=>{expect(validDay('2026-10-13')).toBe(true);expect(validDay('2024-02-29')).toBe(true);for(const value of['2026-02-29','2026-02-30','2026-13-01','2026-1-3','invalid'])expect(validDay(value)).toBe(false);});
  it('跨月跨年按日递增，日期标题以北京时间显示',()=>{expect(shiftDay('2026-10-01',-1)).toBe('2026-09-30');expect(shiftDay('2026-12-31',1)).toBe('2027-01-01');expect(dateTitle('2026-10-13','2026-10-13')).toContain('星期二');expect(dateTitle('2026-10-13','2026-10-14')).not.toContain('今天');});
});
