// Operator-tunable integers from the environment.  A value that is not a
// positive integer keeps the default, so a typo cannot disable a cap.
export const envInt = (name, dflt) => {
    const v = +(process.env[name] ?? NaN);
    return Number.isInteger(v) && v > 0 ? v : dflt;
};
