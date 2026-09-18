using UnityEditor;

namespace Game.Editor
{
    public static class BuildScript
    {
        public static void BuildServer()
        {
            var options = new BuildPlayerOptions();
            options.subtarget = (int)StandaloneBuildSubtarget.Server;
        }
    }
}
