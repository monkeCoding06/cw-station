/* Stations heard or read during this visit. Kept in memory only; a refresh starts empty. */
const heard = new Set();

export const noteHeard = call => { if (call) heard.add(call); };
export const heardStations = () => [...heard];
