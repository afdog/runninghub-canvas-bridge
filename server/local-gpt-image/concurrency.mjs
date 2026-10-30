// null means the local scheduler imposes no concurrent-image limit.
export function isImageConcurrency(value){
  return value===null||(Number.isSafeInteger(value)&&value>=1);
}
export function imageConcurrencyLabel(value){
  return value===null?'不限':value+' 张';
}
export function imagePoolFull(pool){
  return !!pool&&pool.maxConcurrentImages!==null&&pool.runningImages>=pool.maxConcurrentImages;
}
