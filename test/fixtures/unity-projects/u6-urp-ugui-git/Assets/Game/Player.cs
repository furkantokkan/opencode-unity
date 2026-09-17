using UnityEngine;
using UnityEngine.UI;
using Cysharp.Threading.Tasks;
using VContainer;

namespace Game
{
    public class Player : MonoBehaviour
    {
        private float _speed1;
        private float _speed2;
        private float _speed3;
        private float _speed4;
        private float _speed5;
        private float _speed6;
        private Canvas _canvas;
        private int _health;

        private async UniTask WarmUpAsync() { await UniTask.Yield(); }
    }
}
